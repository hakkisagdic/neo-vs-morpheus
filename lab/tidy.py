#!/usr/bin/env python3
"""Keeps the project's outputs from filling the disk: what takes space, and what the rules would do.

    python3 lab/tidy.py                        # a dry run: every rule, what it would free
    python3 lab/tidy.py --apply compress       # do the rules named (comma separated, or "all")

Rules:
- compress     run files (runs/, .fleet/alastyr/runs/) older than a day get APFS transparent
               compression: the same files, read the same way by every script, 10-15 times smaller
               on disk (lossless; a run file is written once and never again);
- duplicates   .fleet/alastyr/runs/ files already brought into runs/ (as alastyr--<stamp>.json);
- checkpoints  local model checkpoints that no lane, plan or gate needs and that Hugging Face keeps
               as a tag (hf download --revision <tag> brings one back);
- sessions     agent sessions and PvE tracks older than --days (default 30), videos included;
- logs         the EA installer's and patcher's logs in ~/UO;
- docker       Docker's build cache older than a week, and dangling images (Docker is shared with
               other projects: they only lose cached layers and rebuild them).
Which rules run unattended is the user's call; compress is lossless. Standard library only.
"""
import argparse
import glob
import json
import os
import shutil
import stat
import subprocess
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAY = 86400
RULES = ["compress", "duplicates", "checkpoints", "sessions", "logs", "docker"]


def size(path):
    """Bytes the path takes on disk (compressed files count as compressed)."""
    if os.path.isfile(path):
        return os.stat(path).st_blocks * 512
    return sum(os.stat(os.path.join(d, f)).st_blocks * 512 for d, _, fs in os.walk(path) for f in fs)


def gb(n):
    return f"{n / 1e9:.1f} GB"


def compressed(path):
    return bool(os.stat(path).st_flags & stat.UF_COMPRESSED)


def rule_compress(apply):
    files = [f for pattern in ("runs/*.json", ".fleet/alastyr/runs/*.json") for f in glob.glob(os.path.join(ROOT, pattern))
             if time.time() - os.path.getmtime(f) > DAY and not compressed(f)]
    before = sum(size(f) for f in files)
    if apply:
        for f in files:
            tmp = f + ".tidy"
            if subprocess.run(["ditto", "--hfsCompression", f, tmp], capture_output=True).returncode == 0:
                os.replace(tmp, f)
            elif os.path.exists(tmp):
                os.remove(tmp)
        after = sum(size(f) for f in files)
        return f"compressed {len(files)} run files: {gb(before)} -> {gb(after)}"
    return f"{len(files)} run files to compress ({gb(before)} now, about {gb(before / 12)} after)"


def rule_duplicates(apply):
    have = {f[len("alastyr--"):] for f in os.listdir(os.path.join(ROOT, "runs")) if f.startswith("alastyr--")}
    dups = [os.path.join(ROOT, ".fleet", "alastyr", "runs", f) for f in os.listdir(os.path.join(ROOT, ".fleet", "alastyr", "runs"))
            if f in have] if os.path.isdir(os.path.join(ROOT, ".fleet", "alastyr", "runs")) else []
    freed = sum(size(f) for f in dups)
    if apply:
        for f in dups:
            os.remove(f)
    return f"{'removed' if apply else 'would remove'} {len(dups)} alastyr copies already in runs/ ({gb(freed)})"


def needed_models():
    """Models something needs: the gate's champion and candidates, the lane plan, the Laya servers running."""
    need = set()
    trainer = json.load(open(os.path.join(ROOT, ".fleet", "trainer.json")))
    need.add(trainer.get("champion"))
    need.update((trainer.get("candidates") or {}).values())
    need.update(trainer.get("keep_models", []))

    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if k in ("model", "modelB") and isinstance(v, str):
                    need.add(v)
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(json.load(open(os.path.join(ROOT, ".fleet", "plan.json"))))
    served = subprocess.run(["pgrep", "-fl", "serve_checkpoint.py"], capture_output=True, text=True).stdout
    need.update(os.path.basename(line.split()[-1].rstrip("/")) for line in served.splitlines() if line.strip())
    return {m for m in need if m}


def hf_tags(repo="hakkisagdic/laya-neo-duel"):
    token = open(os.path.expanduser("~/.cache/huggingface/token")).read().strip()
    req = urllib.request.Request(f"https://huggingface.co/api/models/{repo}/refs", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return {t["name"] for t in json.load(r).get("tags", [])}


def rule_checkpoints(apply, previous=1):
    folder = os.path.join(ROOT, "training", "checkpoints")
    need = needed_models()
    tags = hf_tags()
    # The champion before this one stays too: the first to fall back on.
    local = sorted(os.listdir(folder), key=lambda m: os.path.getmtime(os.path.join(folder, m)))
    spare = [m for m in local if m not in need and m in tags]
    freed = sum(size(os.path.join(folder, m)) for m in spare)
    missing = [m for m in local if m not in need and m not in tags]
    if apply:
        for m in spare:
            shutil.rmtree(os.path.join(folder, m))
    note = f"; {len(missing)} not on Hugging Face, kept: {', '.join(missing)}" if missing else ""
    return f"{'removed' if apply else 'would remove'} {len(spare)} checkpoints on Hugging Face that nothing uses ({gb(freed)}); kept {sorted(need & set(local))}{note}"


def rule_sessions(apply, days):
    old = [d for base in ("~/UO/sessions", "~/UO/pve") for d in glob.glob(os.path.join(os.path.expanduser(base), "*"))
           if os.path.isdir(d) and time.time() - os.path.getmtime(d) > days * DAY]
    freed = sum(size(d) for d in old)
    if apply:
        for d in old:
            shutil.rmtree(d)
    return f"{'removed' if apply else 'would remove'} {len(old)} sessions older than {days} days ({gb(freed)})"


def rule_logs(apply):
    logs = [f for f in glob.glob(os.path.expanduser("~/UO/*.log")) if os.path.basename(f).startswith(("installer", "patcher", "tonight"))]
    freed = sum(size(f) for f in logs)
    if apply:
        for f in logs:
            os.remove(f)
    return f"{'removed' if apply else 'would remove'} {len(logs)} installer and patcher logs ({gb(freed)})"


def rule_docker(apply):
    if not apply:
        df = subprocess.run(["docker", "system", "df"], capture_output=True, text=True).stdout.splitlines()
        return "would prune Docker's week-old build cache and dangling images; now: " + " | ".join(" ".join(l.split()[:5]) for l in df[1:5])
    out = []
    for cmd in (["docker", "builder", "prune", "-f", "--filter", "until=168h"], ["docker", "image", "prune", "-f"]):
        done = subprocess.run(cmd, capture_output=True, text=True)
        out.append((done.stdout.strip().splitlines() or ["?"])[-1])
    return "docker: " + "; ".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", default="", help="the rules to carry out, comma separated, or all")
    ap.add_argument("--days", type=int, default=30, help="how old a session may get")
    args = ap.parse_args()
    apply = set(RULES) if args.apply == "all" else {r.strip() for r in args.apply.split(",") if r.strip()}
    unknown = apply - set(RULES)
    if unknown:
        raise SystemExit(f"unknown rules: {', '.join(sorted(unknown))}")
    for name in RULES:
        fn = globals()[f"rule_{name}"]
        try:
            text = fn(name in apply, args.days) if name == "sessions" else fn(name in apply)
        except Exception as e:  # one rule's trouble does not stop the others
            text = f"failed: {type(e).__name__}: {e}"
        print(f"{name:12} {text}", flush=True)


if __name__ == "__main__":
    main()
