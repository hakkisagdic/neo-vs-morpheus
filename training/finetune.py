#!/usr/bin/env python3
"""Fine-tune Laya (typed-decisions) on duel decisions distilled from a teacher model.

Adapted from upstream's notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb (Apache-2.0):
the same objective (RLCD: a proper-scoring-rule policy gradient plus soft cross-entropy on the
teacher's full distribution), reshaped for one device (Apple MPS, CUDA or CPU).

Two modes:
  --mode head (default)  run the frozen encoder once, keep its outputs, train only the decision
                         head (~26M parameters). About 1.5 GB of memory: fits a busy 16 GB Mac.
  --mode top             also train the top encoder layers (--train-top-layers). Needs roughly
                         7 GB; meant for a machine with a real GPU (e.g. a free Kaggle/Colab T4).

Run it with the native Laya env (scripts/laya-native.sh start creates it):

    HF_HOME=.laya/hf .laya/venv/bin/python training/finetune.py \\
        --data training/data/labeled.jsonl --out training/checkpoints/neo-duel
"""
import argparse
import json
import math
import os
import random
import shutil
import time

import torch
from huggingface_hub import snapshot_download
from laya.agent import _fix_tokenizer_config
from laya.common import QTYPES, build_model, build_sequence, proper_reward
from safetensors.torch import load_file, save_file
from transformers import AutoTokenizer

BASE_REPO = "convaiinnovations/laya"
BASE_SUBFOLDER = "typed-decisions"


def pick_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def load_items(path, tok, cfg):
    """One training item per labeled state: token ids, option marker positions, soft target."""
    items, skipped = [], 0
    with open(path) as f:
        for line in f:
            r = json.loads(line)
            q = r["questions"]["move"]
            keys = list(q["criteria"].keys())
            probs = r["teacher"]["probabilities"]
            target = [max(0.0, float(probs.get(k, 0.0))) for k in keys]
            total = sum(target)
            target = [t / total for t in target] if total > 0 else [1.0 / len(keys)] * len(keys)
            ids, markers = build_sequence(
                tok, r["state"], {"t": "choice", "ins": q["instructions"], "crit": q["criteria"]},
                cfg["max_len"], cfg["head_max_len"],
            )
            if len(markers) != len(keys):
                skipped += 1
                continue
            items.append({
                "id": r["id"], "ids": ids, "markers": markers, "qtype": QTYPES["choice"],
                "target": target, "label": target.index(max(target)),
            })
    return items, skipped


def collate(items, pad_id):
    n, length = len(items), max(len(it["ids"]) for it in items)
    kmax = max(len(it["markers"]) for it in items)
    ids = torch.full((n, length), pad_id, dtype=torch.long)
    att = torch.zeros((n, length), dtype=torch.long)
    mpos = torch.zeros((n, kmax), dtype=torch.long)
    mmask = torch.zeros((n, kmax), dtype=torch.bool)
    target = torch.zeros((n, kmax), dtype=torch.float32)
    for i, it in enumerate(items):
        ids[i, : len(it["ids"])] = torch.tensor(it["ids"])
        att[i, : len(it["ids"])] = 1
        k = len(it["markers"])
        mpos[i, :k] = torch.tensor(it["markers"])
        mmask[i, :k] = True
        target[i, :k] = torch.tensor(it["target"])
    return {
        "input_ids": ids, "attention_mask": att, "marker_pos": mpos, "marker_mask": mmask,
        "target": target, "qtype": torch.tensor([it["qtype"] for it in items]),
    }


def forward(model, batch, device):
    logits, act = model(
        batch["input_ids"].to(device), batch["attention_mask"].to(device),
        batch["marker_pos"].to(device), batch["marker_mask"].to(device), batch["qtype"].to(device),
    )
    return logits.float(), act


@torch.no_grad()
def evaluate(run, items, make_batch, batch_size=16):
    """Top-1 agreement with the teacher and mean soft cross-entropy; also returns the logits."""
    agree, ce, rows = 0, 0.0, []
    for i in range(0, len(items), batch_size):
        chunk = items[i:i + batch_size]
        b = make_batch(chunk)
        with torch.no_grad():
            logits = run(b, train=False)
        mask = b["marker_mask"].to(logits.device)
        logp = torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)
        ce += float(-(b["target"].to(logits.device) * logp).sum(-1).sum())
        for r, it in enumerate(chunk):
            z = logits[r, : len(it["markers"])].cpu()
            agree += int(int(z.argmax()) == it["label"])
            rows.append((z.tolist(), it["target"]))
    n = max(1, len(items))
    return agree / n, ce / n, rows


def fit_temperature(rows):
    """One temperature for choice questions, fitted on held-out logits (as upstream does)."""
    kmax = max(len(z) for z, _ in rows)
    z_all = torch.full((len(rows), kmax), -1e4)
    t_all = torch.zeros((len(rows), kmax))
    for i, (z, t) in enumerate(rows):
        z_all[i, :len(z)] = torch.tensor(z)
        t_all[i, :len(t)] = torch.tensor(t)
    log_t = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=100)

    def closure():
        opt.zero_grad()
        loss = -(t_all * torch.log_softmax(z_all / log_t.exp(), -1)).sum(-1).mean()
        loss.backward()
        return loss

    opt.step(closure)
    t = float(log_t.exp().item())
    if not math.isfinite(t):
        # LBFGS can diverge (NaN) when the head is still undertrained and the
        # held-out logits are flat; fall back to a coarse grid search.
        t = grid_temperature(z_all, t_all)
    return max(0.5, min(5.0, t))


def grid_temperature(z_all, t_all):
    """Temperature in 0.5..5.0 (steps of 0.05) with the lowest soft cross-entropy; NaN-safe."""
    ok = torch.isfinite(z_all).all(-1) & torch.isfinite(t_all).all(-1)
    if not ok.any():
        return 1.0
    z_all, t_all = z_all[ok], t_all[ok]
    grid = torch.tensor([x / 20 for x in range(10, 101)])
    losses = -(t_all * torch.log_softmax(z_all[None] / grid[:, None, None], -1)).sum(-1).mean(-1)
    return float(grid[torch.argmin(torch.nan_to_num(losses, nan=float("inf")))].item())


class Head(torch.nn.Module):
    """The decision head of a DecisionModel, fed cached encoder outputs instead of token ids."""

    def __init__(self, model):
        super().__init__()
        self.type_emb, self.head, self.scorer, self.act_head = model.type_emb, model.head, model.scorer, model.act_head

    def forward(self, h, attention_mask, marker_pos, marker_mask, qtype):
        h = h + self.type_emb(qtype)[:, None, :]
        pad = ~attention_mask.bool()
        for layer in self.head.layers:
            h = layer(h, src_key_padding_mask=pad)
        idx = marker_pos.clamp(min=0)[:, :, None].expand(-1, -1, h.size(-1))
        logits = self.scorer(torch.gather(h, 1, idx)).squeeze(-1).float()
        return logits.masked_fill(~marker_mask, -1e4), None


@torch.no_grad()
def encode_all(model, items, pad_id, device, batch_size=4):
    """Runs the frozen encoder once per item (fp16) and keeps last_hidden_state on the CPU."""
    enc = model.encoder.half().to(device).eval()
    for i in range(0, len(items), batch_size):
        chunk = items[i:i + batch_size]
        b = collate(chunk, pad_id)
        h = enc(input_ids=b["input_ids"].to(device), attention_mask=b["attention_mask"].to(device)).last_hidden_state
        for r, it in enumerate(chunk):
            it["h"] = h[r, : len(it["ids"])].to("cpu", torch.float16)
        if (i // batch_size) % 50 == 0:
            print(f"  encoded {min(i + batch_size, len(items))}/{len(items)}")
    enc.to("cpu")
    if device.type == "mps":
        torch.mps.empty_cache()


def collate_h(items, pad_id):
    b = collate(items, pad_id)
    h = torch.zeros((len(items), b["input_ids"].size(1), items[0]["h"].size(-1)), dtype=torch.float32)
    for i, it in enumerate(items):
        h[i, : it["h"].size(0)] = it["h"].float()
    b["h"] = h
    return b


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="training/data/labeled.jsonl")
    ap.add_argument("--out", default="training/checkpoints/neo-duel")
    ap.add_argument("--mode", choices=["head", "top"], default="head")
    ap.add_argument("--epochs", type=int, default=None, help="default: 8 for head, 3 for top")
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--accum", type=int, default=2)
    ap.add_argument("--train-top-layers", type=int, default=8, help="--mode top: encoder layers to train")
    ap.add_argument("--lr-encoder", type=float, default=2.5e-5)
    ap.add_argument("--lr-head", type=float, default=1e-4)
    ap.add_argument("--holdout", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=20260927)
    ap.add_argument("--init", help="start from this fine-tuned checkpoint (its model.safetensors) instead of the base model, "
                                   "to improve a champion rather than learn from scratch; pair it with low learning rates")
    ap.add_argument("--precision", choices=["fp32", "bf16", "fp16"], default="fp32",
                    help="CUDA only: run the model in bf16 (Ampere and newer) or fp16 with loss scaling (T4, P100)")
    ap.add_argument("--no-checkpointing", action="store_true",
                    help="--mode top: keep activations instead of recomputing them (faster, needs more memory)")
    args = ap.parse_args()
    args.epochs = args.epochs or (8 if args.mode == "head" else 3)

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = pick_device()
    if args.precision != "fp32" and device.type != "cuda":
        print(f"--precision {args.precision} needs CUDA; training in fp32 on {device.type}")
        args.precision = "fp32"
    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16}.get(args.precision)

    def autocast():
        return torch.autocast(device_type=device.type, dtype=dtype, enabled=dtype is not None)

    base = os.path.join(snapshot_download(BASE_REPO, allow_patterns=[f"{BASE_SUBFOLDER}/*"]), BASE_SUBFOLDER)
    _fix_tokenizer_config(base)
    tok = AutoTokenizer.from_pretrained(os.path.join(base, "tokenizer"))
    with open(os.path.join(base, "rl_agent_config.json")) as f:
        cfg = json.load(f)

    items, skipped = load_items(args.data, tok, cfg)
    order = list(range(len(items)))
    random.Random(args.seed).shuffle(order)
    n_hold = max(1, int(len(items) * args.holdout))
    hold = [items[i] for i in order[:n_hold]]
    train = [items[i] for i in order[n_hold:]]
    lengths = sorted(len(it["ids"]) for it in items)
    print(f"device {device} | {args.precision} | mode {args.mode} | {len(items)} items ({skipped} skipped: options did not fit) | "
          f"train {len(train)} / held out {len(hold)} | tokens p50 {lengths[len(lengths) // 2]} max {lengths[-1]}")

    # The weights training starts from, and that the saved checkpoint keeps where nothing was trained.
    base_weights = load_file(os.path.join(args.init or base, "model.safetensors"))
    model = build_model(cfg, encoder_dir=os.path.join(base, "encoder"))
    model.load_state_dict(base_weights, strict=True)
    pad = tok.pad_token_id

    if args.mode == "head":
        # The encoder never changes: run it once, then train the head on its outputs.
        encode_all(model, items, pad, device)
        net = Head(model).float().to(device)
        del model
        make_batch = lambda chunk: collate_h(chunk, pad)  # noqa: E731

        def run(b, train):
            net.train(train)
            with autocast():
                logits, _ = net(b["h"].to(device), b["attention_mask"].to(device), b["marker_pos"].to(device),
                                b["marker_mask"].to(device), b["qtype"].to(device))
            return logits.float()

        trainable = list(net.named_parameters())
        groups = [{"params": [p for _, p in trainable], "lr": args.lr_head}]
    else:
        n_layers = model.encoder.config.num_hidden_layers
        first = n_layers - args.train_top_layers
        for name, p in model.named_parameters():
            if name.startswith("encoder."):
                parts = name.split(".")
                layer = int(parts[2]) if parts[1] == "layers" and parts[2].isdigit() else None
                p.requires_grad = (layer is not None and layer >= first) or name.startswith("encoder.final_norm")
        model.float()
        if not args.no_checkpointing:
            model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
            model.head_checkpointing = True
        net = model.to(device)
        make_batch = lambda chunk: collate(chunk, pad)  # noqa: E731

        def run(b, train):
            net.train(train)
            with autocast():
                logits, _ = forward(net, b, device)
            return logits.float()

        trainable = [(n, p) for n, p in net.named_parameters() if p.requires_grad]
        groups = [
            {"params": [p for n, p in trainable if n.startswith("encoder.")], "lr": args.lr_encoder},
            {"params": [p for n, p in trainable if not n.startswith("encoder.")], "lr": args.lr_head},
        ]
    print(f"trainable parameters: {sum(p.numel() for _, p in trainable) / 1e6:.1f}M")

    agree0, ce0, _ = evaluate(run, hold, make_batch)
    print(f"before: held-out agreement with teacher {agree0:.3f}, soft CE {ce0:.3f}")

    optimizer = torch.optim.AdamW(groups, weight_decay=0.01)
    steps = max(1, math.ceil(len(train) / args.batch / args.accum) * args.epochs)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=steps, eta_min=1e-6)
    params = [p for _, p in trainable]
    # fp16 needs loss scaling against underflow; with bf16 or fp32 the scaler passes everything through.
    scaler = torch.amp.GradScaler(device.type, enabled=args.precision == "fp16")

    group, sigma_start, sigma_end = 4, 0.4, 0.1
    t0 = time.time()
    for epoch in range(args.epochs):
        random.Random(args.seed + epoch).shuffle(train)
        sigma = sigma_start + (sigma_end - sigma_start) * epoch / max(1, args.epochs - 1)
        total, n = 0.0, 0
        optimizer.zero_grad(set_to_none=True)
        for step, i in enumerate(range(0, len(train), args.batch)):
            b = make_batch(train[i:i + args.batch])
            logits = run(b, train=True)
            mask = b["marker_mask"].to(device)
            k = mask.sum(-1, keepdim=True).float()
            target = b["target"].to(device)

            # RLCD: sample noisy distributions around the logits, reward them with a strictly
            # proper scoring rule against the teacher, push the logits towards the better ones.
            eps = torch.randn((group,) + logits.shape, device=device) * sigma * mask
            eps = (eps - eps.sum(-1, keepdim=True) / k) * mask
            z = logits.detach().unsqueeze(0) + eps
            q = torch.softmax(z.masked_fill(~mask, -1e4), -1)
            with torch.no_grad():
                r = proper_reward(q, target.unsqueeze(0), b["qtype"].to(device), mask, w_sph=0.75, w_rps=1.0)
                adv = (r - r.mean(0, keepdim=True)) / (r.std() + 1e-6)
            logp = -(((z - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma ** 2)
            loss_rl = -(adv * logp).mean()
            loss_ce = -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)).sum(-1).mean()
            scaler.scale((loss_rl + loss_ce) / args.accum).backward()

            if (step + 1) % args.accum == 0 or i + args.batch >= len(train):
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                scaler.step(optimizer)
                scaler.update()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)
            total += float(loss_ce)
            n += 1
        agree, ce, _ = evaluate(run, hold, make_batch)
        print(f"epoch {epoch + 1}/{args.epochs}: train soft CE {total / max(1, n):.3f} | "
              f"held-out agreement {agree:.3f}, soft CE {ce:.3f} ({time.time() - t0:.0f} s)")

    _, _, rows = evaluate(run, hold, make_batch)
    temperature = fit_temperature(rows)
    print(f"fitted choice temperature {temperature:.3f}")

    # Save in Laya's checkpoint layout: the base weights with the trained tensors swapped in.
    trained = {name: p.detach() for name, p in net.state_dict().items()}
    merged = dict(base_weights)
    for name, value in trained.items():
        if name in merged:
            merged[name] = value.to(merged[name].dtype).contiguous().cpu()
    os.makedirs(args.out, exist_ok=True)
    save_file({k: v.contiguous() for k, v in merged.items()}, os.path.join(args.out, "model.safetensors"))
    shutil.copytree(os.path.join(base, "encoder"), os.path.join(args.out, "encoder"), dirs_exist_ok=True)
    tok.save_pretrained(os.path.join(args.out, "tokenizer"))
    cfg.update({
        "fine_tuned": True,
        "model_name": "laya-neo-duel",
        "temperature": [temperature, cfg["temperature"][1], cfg["temperature"][2]],
        "training": {"mode": args.mode, "epochs": args.epochs, "items": len(train), "teacher": "jev",
                     "base": f"{BASE_REPO}/{BASE_SUBFOLDER}", **({"init": os.path.basename(os.path.normpath(args.init))} if args.init else {}),
                     "seconds": round(time.time() - t0),
                     "held_out_agreement": [round(agree0, 3), round(agree, 3)]},
    })
    cfg.pop("temperature_by_options", None)
    with open(os.path.join(args.out, "rl_agent_config.json"), "w") as f:
        json.dump(cfg, f, indent=2)
    print(f"saved {args.out}")


if __name__ == "__main__":
    main()
