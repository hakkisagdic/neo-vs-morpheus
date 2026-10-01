#!/usr/bin/env python3
"""Fine-tune Laya on a free Kaggle GPU and bring the checkpoint home.

Needs the Kaggle CLI, logged in, on a phone-verified account (GPUs and internet in kernels):

    uv tool install kaggle && kaggle auth login

Then, from the repo root (standard library only):

    python3 training/kaggle.py all --name neo-duel-v5 --data training/data/train-v5.jsonl
    python3 training/kaggle.py train  --name ...   # upload the labels, start the kernel
    python3 training/kaggle.py status --name ...   # queued, running, complete or error
    python3 training/kaggle.py fetch  --name ...   # download the checkpoint, check every file

Every run is its own private dataset (the labels, gzipped) and its own private script kernel, so
several can run side by side. The kernel clones this repository at the local HEAD, so push first;
it pip-installs Laya, trains with training/finetune.py, and leaves the checkpoint in
/kaggle/working with a SHA-256 for every file in its log. Kaggle's T4 and P100 have no bf16, so
the default is fp16 with loss scaling, and batch 16 with 4-step accumulation (64 per step).
A week holds 30 GPU hours (`kaggle quota`).
"""
import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REPO_URL = "https://github.com/hakkisagdic/neo-vs-morpheus.git"
LAYA = "laya==0.3.20"


def kaggle(*args, check=True):
    out = subprocess.run(["kaggle", *args], capture_output=True, text=True)
    if check and out.returncode != 0:
        sys.exit(f"kaggle {' '.join(args)} failed: {(out.stderr or out.stdout).strip()[-1500:]}")
    return out.stdout


def git(*a):
    return subprocess.run(["git", "-C", ROOT, *a], capture_output=True, text=True).stdout.strip()


def user():
    """The logged-in Kaggle username (`kaggle config view` prints it)."""
    match = re.search(r"username:\s*(\S+)", kaggle("config", "view"))
    if not match:
        sys.exit("not logged in to Kaggle: run `kaggle auth login`")
    return match.group(1)


def slug(name):
    """Kaggle ids are lower-case words joined by hyphens."""
    return re.sub(r"[^a-z0-9-]+", "-", name.lower()).strip("-")


KERNEL = '''# neo-vs-morpheus: train {name} on a Kaggle GPU (written by training/kaggle.py)
import glob, gzip, hashlib, os, subprocess, sys

repo = "/tmp/neo-vs-morpheus"
out = "/kaggle/working/{name}"
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "{laya}"], check=True)
subprocess.run(["git", "clone", "-q", "{repo_url}", repo], check=True)
subprocess.run("git fetch -q --depth 1 origin {commit} && git checkout -q FETCH_HEAD", shell=True, check=True, cwd=repo)
os.makedirs(repo + "/training/data", exist_ok=True)
# Where Kaggle mounts a dataset, and whether it unpacks the .gz, has changed over time: search.
found = sorted(glob.glob("/kaggle/input/**/labels.jsonl*", recursive=True))
print("labels file:", found, flush=True)
if not found:
    raise SystemExit("no labels under /kaggle/input: " + repr([p for p in glob.glob("/kaggle/input/**", recursive=True)][:20]))
with (gzip.open if found[0].endswith(".gz") else open)(found[0], "rb") as f:
    data = f.read()
with open(repo + "/training/data/labeled.jsonl", "wb") as f:
    f.write(data)
print("labels", data.count(b"\\n"), "lines, checksum", "ok" if hashlib.sha256(data).hexdigest() == "{digest}" else "MISMATCH", flush=True)
print(subprocess.run(["git", "log", "--oneline", "-1"], capture_output=True, text=True, cwd=repo).stdout.strip(), flush=True)
print(subprocess.run("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader", shell=True, capture_output=True, text=True).stdout.strip(), flush=True)
subprocess.run([sys.executable, "-u", "training/finetune.py", "--mode", "top", "--data", "training/data/labeled.jsonl",
                "--out", out, *{args}], check=True, cwd=repo)
for root, _, files in os.walk(out):
    for f in sorted(files):
        path = os.path.join(root, f)
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 24), b""):
                h.update(chunk)
        print("sha256", h.hexdigest(), os.path.relpath(path, out), flush=True)
'''


def train(args):
    commit = git("rev-parse", "HEAD")
    if git("branch", "-r", "--contains", commit) == "":
        sys.exit(f"commit {commit[:9]} is not on GitHub yet; push first (the kernel clones it)")
    owner = user()
    name = slug(args.name)
    with open(os.path.join(ROOT, args.data), "rb") as f:
        data = f.read()
    with tempfile.TemporaryDirectory(prefix="kaggle-") as tmp:
        # The labels: a private dataset per run, so runs never race over one dataset's versions.
        ds_dir = os.path.join(tmp, "dataset")
        os.makedirs(ds_dir)
        with gzip.open(os.path.join(ds_dir, "labels.jsonl.gz"), "wb", compresslevel=9) as f:
            f.write(data)
        dataset = f"{name}-labels"
        with open(os.path.join(ds_dir, "dataset-metadata.json"), "w") as f:
            json.dump({"title": dataset, "id": f"{owner}/{dataset}", "licenses": [{"name": "other"}]}, f)
        exists = kaggle("datasets", "status", f"{owner}/{dataset}", check=False).strip() == "ready"
        if exists:
            kaggle("datasets", "version", "-p", ds_dir, "-m", f"labels for {name} at {commit[:9]}")
        else:
            kaggle("datasets", "create", "-p", ds_dir)
        for _ in range(60):
            if kaggle("datasets", "status", f"{owner}/{dataset}", check=False).strip() == "ready":
                break
            time.sleep(5)
        else:
            sys.exit(f"dataset {owner}/{dataset} is not ready after 5 minutes")
        lines = data.count(b"\n")
        print(f"labels: {lines} lines -> private dataset {owner}/{dataset}")

        # The kernel: a private GPU script that trains and leaves the checkpoint in its output.
        k_dir = os.path.join(tmp, "kernel")
        os.makedirs(k_dir)
        train_args = ["--train-top-layers", str(args.train_top_layers), "--epochs", str(args.epochs),
                      "--batch", str(args.batch), "--accum", str(args.accum), "--holdout", str(args.holdout),
                      "--precision", args.precision] + (["--no-checkpointing"] if args.no_checkpointing else [])
        with open(os.path.join(k_dir, "train.py"), "w") as f:
            f.write(KERNEL.format(name=name, laya=LAYA, repo_url=REPO_URL, commit=commit, dataset=dataset,
                                  digest=hashlib.sha256(data).hexdigest(), args=repr(train_args)))
        kernel = f"{name}-train"
        with open(os.path.join(k_dir, "kernel-metadata.json"), "w") as f:
            json.dump({"id": f"{owner}/{kernel}", "title": kernel, "code_file": "train.py", "language": "python",
                       "kernel_type": "script", "is_private": True, "enable_gpu": True, "enable_internet": True,
                       "dataset_sources": [f"{owner}/{dataset}"], "competition_sources": [], "kernel_sources": [],
                       "machine_shape": args.accelerator}, f)
        print(kaggle("kernels", "push", "-p", k_dir).strip())
    print(f"kernel {owner}/{kernel} started at {commit[:9]} on {args.accelerator}: {' '.join(train_args)}")


def status(args, quiet=False):
    out = kaggle("kernels", "status", f"{user()}/{slug(args.name)}-train", check=False).strip()
    state = re.search(r'status "?([\w.]+)', out)
    if not quiet:
        print(out)
    return state.group(1).lower() if state else "unknown"


def wait(args):
    while True:
        state = status(args, quiet=True)
        print(time.strftime("%H:%M"), state, flush=True)
        if "complete" in state or "error" in state or "cancel" in state:
            return state
        time.sleep(60)


def fetch(args):
    name = slug(args.name)
    kernel = f"{user()}/{name}-train"
    local = os.path.join(ROOT, "training", "checkpoints", name)
    with tempfile.TemporaryDirectory(prefix="kaggle-out-", dir=os.path.join(ROOT, "training", "checkpoints")) as tmp:
        kaggle("kernels", "output", kernel, "-p", tmp)
        logs = [f for f in os.listdir(tmp) if f.endswith(".log")]
        log = open(os.path.join(tmp, logs[0])).read() if logs else ""
        try:
            # Kaggle keeps the log as JSON: [{"stream_name": "stdout", "time": ..., "data": "..."}, ...]
            log = "".join(entry.get("data", "") for entry in json.loads(log))
        except (ValueError, AttributeError):
            pass
        digests = {rel: digest for digest, rel in re.findall(r"sha256 ([0-9a-f]{64}) (\S+)", log)}
        src = os.path.join(tmp, name)
        if not digests or not os.path.isdir(src):
            tail = "\n".join(log.splitlines()[-30:])
            sys.exit(f"no checkpoint in the kernel's output; the log ends with:\n{tail}")
        for rel, digest in digests.items():
            h = hashlib.sha256()
            with open(os.path.join(src, rel), "rb") as f:
                for chunk in iter(lambda: f.read(1 << 24), b""):
                    h.update(chunk)
            if h.hexdigest() != digest:
                sys.exit(f"checksum mismatch for {rel}")
        if os.path.exists(local):
            shutil.rmtree(local)
        shutil.move(src, local)
        for line in log.splitlines():
            if any(k in line for k in ("device", "before:", "epoch", "fitted")):
                print(line.strip()[:200])
    print(f"checkpoint ready: training/checkpoints/{name}, {len(digests)} files checked "
          f"(serve it with scripts/laya-native.sh start training/checkpoints/{name})")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["train", "status", "wait", "fetch", "all"])
    ap.add_argument("--name", required=True, help="run name; also names the dataset and the kernel")
    ap.add_argument("--data", default="training/data/train-all.jsonl")
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--accum", type=int, default=4)
    ap.add_argument("--train-top-layers", type=int, default=28, help="28 = the whole encoder")
    ap.add_argument("--holdout", type=float, default=0.05)
    ap.add_argument("--precision", choices=["fp32", "fp16"], default="fp16")
    ap.add_argument("--no-checkpointing", action="store_true", help="keep activations: faster, needs more memory")
    ap.add_argument("--accelerator", choices=["NvidiaTeslaT4", "NvidiaTeslaP100"], default="NvidiaTeslaT4")
    args = ap.parse_args()
    if args.command in ("train", "all"):
        train(args)
    if args.command == "status":
        status(args)
    if args.command == "wait":
        wait(args)
    if args.command == "all":
        state = wait(args)
        if "complete" not in state:
            sys.exit(f"the kernel ended {state}; see `python3 training/kaggle.py status --name {args.name}`")
    if args.command in ("fetch", "all"):
        fetch(args)


if __name__ == "__main__":
    main()
