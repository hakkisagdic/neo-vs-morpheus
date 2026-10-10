#!/usr/bin/env python3
"""Play series on a Kaggle GPU machine: the arena, the bot and Laya together (2 x T4, 4 CPUs).

    python3 lab/kaggle_arena.py run --name explore-v8 --series lab/series-explore12.json \\
        --lane neo-duel-v8 --lane neo-duel-v8-dagger-all --hours 9
    python3 lab/kaggle_arena.py status --name explore-v8
    python3 lab/kaggle_arena.py fetch --name explore-v8     # runs into runs/ as kaggle--<stamp>.json

The checkpoints go up from this Mac as a private Kaggle dataset, so Kaggle needs no Hugging Face
token; the series file and this checkout's unpushed and uncommitted changes go with them. The
kernel sets up lab/vm at GitHub's main, serves each lane's checkpoint on a GPU of its own, plays
the series again and again until --hours are up, and leaves the runs in its output. Kaggle stops
a session at 12 hours, so the default 9 leaves room for setting up and saving.
Standard library only; needs the Kaggle CLI, logged in (see training/kaggle.py).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "training"))
from kaggle import kaggle, slug, user  # noqa: E402  (training/kaggle.py's helpers)

RUNS = os.path.join(ROOT, "runs")
INSTANCE = "kaggle"

KERNEL = r'''# neo-vs-morpheus: play {series} on Kaggle (written by lab/kaggle_arena.py)
import glob, os, shutil, subprocess, sys, tarfile, time, urllib.request

deadline = time.time() + {hours} * 3600
A, OUT = "/tmp/arena", "/kaggle/working/runs"
os.makedirs(A, exist_ok=True)
os.makedirs(OUT, exist_ok=True)
bundle = os.path.dirname(sorted(glob.glob("/kaggle/input/**/bundle.json", recursive=True))[0])
print("bundle", bundle, os.listdir(bundle), flush=True)
if os.path.exists(f"{{bundle}}/working-tree.patch"):
    shutil.copy(f"{{bundle}}/working-tree.patch", f"{{A}}/working-tree.patch")
urllib.request.urlretrieve("https://raw.githubusercontent.com/hakkisagdic/neo-vs-morpheus/{commit}/lab/vm/setup.sh", f"{{A}}/setup.sh")
env = dict(os.environ, ARENA_DIR=A, COMMIT="{commit}")
subprocess.run(["bash", f"{{A}}/setup.sh"], cwd=A, env=env, check=True)
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "laya[serve]==0.3.20"], check=True)
os.makedirs(f"{{A}}/models", exist_ok=True)
for tar in glob.glob(f"{{bundle}}/*.tar"):
    with tarfile.open(tar) as t:
        t.extractall(f"{{A}}/models")
lanes = {lanes}
gpus = max(1, len(subprocess.run("nvidia-smi -L", shell=True, capture_output=True, text=True).stdout.splitlines()))
for i, tag in enumerate(lanes):
    subprocess.Popen(["bash", f"{{A}}/nvm/lab/vm/model.sh", str(8001 + i), f"{{A}}/models/{{tag}}"],
                     env=dict(env, CUDA_VISIBLE_DEVICES=str(i % gpus)), stdout=open(f"{{A}}/laya-{{8001 + i}}.log", "w"),
                     stderr=subprocess.STDOUT, start_new_session=True)
for i in range(len(lanes)):
    for _ in range(150):
        try:
            if "typed-decisions" in urllib.request.urlopen(f"http://127.0.0.1:{{8001 + i}}/health", timeout=2).read().decode():
                break
        except Exception:
            pass
        time.sleep(2)
    print("lane", i, "serves", lanes[i], flush=True)
series = f"{{bundle}}/series.json"
# Each lane plays the series again and again; a round of it ends well before the deadline.
loop = f'while [ $(date +%s) -lt {{int(deadline)}} ]; do bash {{A}}/nvm/lab/vm/lane.sh $LANE {{series}} --parallel {parallel}; done'
procs = [subprocess.Popen(["bash", "-c", loop], env=dict(env, LANE=str(i), FLEET_INSTANCE="{instance}"),
                          stdout=open(f"{{A}}/lane-{{i}}.log", "w"), stderr=subprocess.STDOUT) for i in range(len(lanes))]
def save():
    for path in glob.glob(f"{{A}}/nvm/runs/*.json"):
        target = os.path.join(OUT, os.path.basename(path))
        if not os.path.exists(target):
            shutil.copy(path, target)
while time.time() < deadline and any(p.poll() is None for p in procs):
    time.sleep(300)
    save()
    print(time.strftime("%H:%M"), len(os.listdir(OUT)), "runs", flush=True)
for p in procs:
    p.terminate()
time.sleep(5)
save()
for i in range(len(lanes)):
    print(f"lane {{i}} log tail:", open(f"{{A}}/lane-{{i}}.log").read()[-600:], flush=True)
print("done:", len(os.listdir(OUT)), "runs", flush=True)
'''


def git(*a):
    return subprocess.run(["git", "-C", ROOT, *a], capture_output=True, text=True).stdout


def working_tree_patch():
    """What a checkout of GitHub's main lacks of this one (as the fleet's workingTreePatch)."""
    subprocess.run(["git", "-C", ROOT, "fetch", "-q", "origin", "main"], check=True)
    patch = git("diff", "--binary", "origin/main", "--", ".")
    folders = ["bot/src", "bot/test", "lab", "tactics", "templates", "training", "server/overlay"]
    for path in git("ls-files", "--others", "--exclude-standard", "--", *folders).split():
        patch += git("diff", "--binary", "--no-index", "--", "/dev/null", path)
    return patch


def run(args):
    owner, name = user(), slug(args.name)
    commit = git("rev-parse", "origin/main").strip()
    with open(os.path.join(ROOT, args.series)) as f:
        series = f.read()
    json.loads(series)
    with tempfile.TemporaryDirectory(prefix="kaggle-arena-") as tmp:
        ds_dir = os.path.join(tmp, "dataset")
        os.makedirs(ds_dir)
        for tag in sorted(set(args.lane)):
            local = os.path.join(ROOT, "training", "checkpoints", tag)
            if not os.path.exists(os.path.join(local, "rl_agent_config.json")):
                sys.exit(f"no {local}: fetch it first (hf download hakkisagdic/laya-neo-duel --revision {tag} --local-dir {local})")
            with tarfile.open(os.path.join(ds_dir, f"{tag}.tar"), "w") as t:
                t.add(local, arcname=tag, filter=lambda ti: None if "/.cache" in ti.name else ti)
        with open(os.path.join(ds_dir, "series.json"), "w") as f:
            f.write(series)
        patch = working_tree_patch()
        if patch:
            with open(os.path.join(ds_dir, "working-tree.patch"), "w") as f:
                f.write(patch)
        with open(os.path.join(ds_dir, "bundle.json"), "w") as f:
            json.dump({"series": os.path.basename(args.series), "lanes": args.lane, "commit": commit}, f)
        dataset = f"{name}-arena"
        with open(os.path.join(ds_dir, "dataset-metadata.json"), "w") as f:
            json.dump({"title": dataset, "id": f"{owner}/{dataset}", "licenses": [{"name": "other"}]}, f)
        if kaggle("datasets", "status", f"{owner}/{dataset}", check=False).strip() == "ready":
            kaggle("datasets", "version", "-p", ds_dir, "-m", f"{args.series} at {commit[:9]}")
        else:
            kaggle("datasets", "create", "-p", ds_dir)
        for _ in range(120):
            if kaggle("datasets", "status", f"{owner}/{dataset}", check=False).strip() == "ready":
                break
            time.sleep(10)
        else:
            sys.exit(f"dataset {owner}/{dataset} is not ready after 20 minutes")
        print(f"bundle: {', '.join(sorted(set(args.lane)))}, {os.path.basename(args.series)}, patch {len(patch)} bytes -> {owner}/{dataset}")

        k_dir = os.path.join(tmp, "kernel")
        os.makedirs(k_dir)
        with open(os.path.join(k_dir, "arena.py"), "w") as f:
            f.write(KERNEL.format(series=os.path.basename(args.series), hours=args.hours, commit=commit, lanes=repr(args.lane),
                                  parallel=args.parallel, instance=INSTANCE))
        kernel = f"{name}-arena-run"
        with open(os.path.join(k_dir, "kernel-metadata.json"), "w") as f:
            json.dump({"id": f"{owner}/{kernel}", "title": kernel, "code_file": "arena.py", "language": "python",
                       "kernel_type": "script", "is_private": True, "enable_gpu": True, "enable_internet": True,
                       "dataset_sources": [f"{owner}/{dataset}"], "competition_sources": [], "kernel_sources": [],
                       "machine_shape": "NvidiaTeslaT4"}, f)
        print(kaggle("kernels", "push", "-p", k_dir).strip())
    print(f"kernel {owner}/{kernel}: {len(args.lane)} lanes x {args.parallel} arenas for {args.hours} h at {commit[:9]}")


def status(args):
    print(kaggle("kernels", "status", f"{user()}/{slug(args.name)}-arena-run", check=False).strip())


def fetch(args):
    sys.path.insert(0, ROOT)
    kernel = f"{user()}/{slug(args.name)}-arena-run"
    with tempfile.TemporaryDirectory(prefix="kaggle-arena-out-") as tmp:
        kaggle("kernels", "output", kernel, "-p", tmp, timeout=1500)  # under the fleet's 30 minutes
        found = [p for p in (os.path.join(r, f) for r, _, fs in os.walk(tmp) for f in fs) if p.endswith(".json") and "/runs/" in p]
        os.makedirs(RUNS, exist_ok=True)
        added = 0
        for path in found:
            base = os.path.basename(path)
            target = os.path.join(RUNS, base if base.startswith(INSTANCE + "--") else f"{INSTANCE}--{base}")
            if os.path.exists(target):
                continue
            try:
                with open(path) as f:
                    json.load(f)
            except ValueError:
                continue
            shutil.copy(path, target)
            added += 1
        logs = [os.path.join(tmp, f) for f in os.listdir(tmp) if f.endswith(".log")]
        if logs:
            text = open(logs[0]).read()
            try:
                text = "".join(e.get("data", "") for e in json.loads(text))
            except (ValueError, AttributeError):
                pass
            print("\n".join(l for l in text.splitlines() if re.search(r"runs|done:|serves|error|Error", l))[-1500:])
    print(f"{len(found)} runs in the output, {added} new in runs/")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["run", "status", "fetch"])
    ap.add_argument("--name", required=True, help="names the dataset and the kernel")
    ap.add_argument("--series", default="lab/series-explore12.json")
    ap.add_argument("--lane", action="append", default=[], help="a checkpoint tag per lane (repeat for more lanes)")
    ap.add_argument("--parallel", type=int, default=4, help="arenas per lane")
    ap.add_argument("--hours", type=float, default=9)
    args = ap.parse_args()
    if args.command == "run":
        if not args.lane:
            sys.exit("give at least one --lane <checkpoint tag>")
        run(args)
    elif args.command == "status":
        status(args)
    else:
        fetch(args)


if __name__ == "__main__":
    main()
