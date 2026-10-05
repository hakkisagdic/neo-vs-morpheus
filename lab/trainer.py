#!/usr/bin/env python3
"""Keeps Kaggle training Laya without a break, one round every 10 minutes:

    python3 lab/trainer.py            # until stopped
    python3 lab/trainer.py --once     # one round

1. A training kernel that finished is fetched (training/kaggle.py fetch), published to the private
   model repo, and put on one of this Mac's candidate lanes against the scripted bot at matched
   speed (lab/evaluate.py), replacing the older candidate there.
2. While fewer than two of the account's GPU sessions run (Kaggle's limit) and the weekly quota has
   room for a training, the next version goes up, two at a time when two wait (a kernel has two
   T4s, so both train in one session): the runs played since the last labeling become
   outcome rows (distill outcomes), the newest set plus those rows becomes the next set
   (build_set.py), and training/kaggle.py starts it. No DAgger rows: the scripted bot's labels made
   neo-duel-v8-dagger-all worse in every build.

State lives in .fleet/trainer.json: the next version number, the newest set, label files every
version keeps (extra), when runs were last labeled, versions built but not pushed (queue), pushed but
not fetched (pushed), and which candidate plays on which lane. Edit it between rounds to change the
plan. Standard library only.
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BOT = os.path.join(ROOT, "bot")
PY = os.path.join(ROOT, ".laya", "venv", "bin", "python")
STATE = os.path.join(ROOT, ".fleet", "trainer.json")
DATA = os.path.join("training", "data")
#: A training this size or smaller is not worth a slot; wait for more runs.
MIN_NEW_ROWS = 3000
#: Hours of weekly GPU quota a training needs (a 50-70k row set takes 3-5 h on a T4).
QUOTA_HOURS = 5.0
#: Runs still playing when runs are labeled are picked up next time: the next labeling starts this much earlier.
OVERLAP = datetime.timedelta(minutes=30)


def log(message):
    print(f"{time.strftime('%H:%M')} {message}", flush=True)


def sh(cmd, cwd=ROOT, timeout=7200):
    out = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return out.returncode, (out.stdout + out.stderr).strip()


def load():
    with open(STATE) as f:
        return json.load(f)


def save(state):
    with open(f"{STATE}.tmp", "w") as f:
        json.dump(state, f, indent=1)
    os.replace(f"{STATE}.tmp", STATE)


def stamp(at):
    """A run file's time stamp format, so that `distill outcomes <since>` compares like with like."""
    return at.strftime("%Y-%m-%dT%H-%M")


def sessions():
    """The account's GPU kernels that ran lately, by name, with their state."""
    code, csv = sh(["kaggle", "kernels", "list", "--mine", "--page-size", "20", "--csv"], timeout=120)
    states = {}
    if code:
        return None
    for line in csv.splitlines()[1:]:
        ref, *_rest = line.split(",")
        at = line.split(",")[3] if len(line.split(",")) > 3 else ""
        try:
            if datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(f"{at.replace(' ', 'T')}+00:00") > datetime.timedelta(hours=14):
                continue
        except ValueError:
            continue
        _, out = sh(["kaggle", "kernels", "status", ref], timeout=120)
        m = re.search(r'status "?(?:KernelWorkerStatus\.)?(\w+)', out)
        states[ref.split("/")[1]] = m.group(1).lower() if m else "unknown"
    return states


def quota_left():
    code, out = sh(["kaggle", "quota"], timeout=120)
    m = re.search(r"^GPU\s+[\d.]+h\s+([\d.]+)h", out, re.M)
    return float(m.group(1)) if m and not code else None


def kernel(state, name):
    """The kernel that trains a version: its own, or the one it shares with its pair."""
    return state.get("kernels", {}).get(name, f"{name}-train")


def fetch(state, name):
    code, out = sh([sys.executable, "training/kaggle.py", "fetch", "--name", name, "--kernel", kernel(state, name)])
    log(f"{name}: fetched" if not code else f"{name}: fetch failed: {out[-300:]}")
    if code:
        return False
    code, out = sh([PY, "training/publish_hf.py", "model", os.path.join("training", "checkpoints", name), "--tag", name, "--card", "docs/hf/laya-neo-duel.md"])
    log(f"{name}: published" if not code else f"{name}: publish failed (kept here): {out[-200:]}")
    return True


def evaluate(state, name):
    """The new checkpoint takes the candidate lane that holds the older candidate."""
    candidates = state.setdefault("candidates", {})
    lanes = state.get("eval_lanes", [0, 2])
    order = state.setdefault("arrived", [])
    free = [l for l in lanes if str(l) not in candidates]
    lane = free[0] if free else min(lanes, key=lambda l: order.index(candidates[str(l)]) if candidates[str(l)] in order else -1)
    code, out = sh([sys.executable, "lab/evaluate.py", "--model", name, "--lane", str(lane)])
    log(f"{name}: evaluating on lane {lane}" if not code else f"{name}: evaluation start failed: {out[-300:]}")
    candidates[str(lane)] = name
    order.append(name)


def build_next(state):
    """Labels the runs since the last labeling and builds the next version's set onto the newest one."""
    n = state["next"]
    name = f"neo-duel-v{n}"
    now = datetime.datetime.now(datetime.timezone.utc)
    code, out = sh(["nice", "-n", "19", "npm", "run", "-s", "nvm", "--", "distill", "outcomes", state["labeled_until"]], cwd=BOT)
    if code:
        log(f"labeling failed: {out[-300:]}")
        return None
    rows = os.path.join(DATA, f"labeled-outcome-v{n}.jsonl")
    shutil.copyfile(os.path.join(ROOT, DATA, "labeled-outcome.jsonl"), os.path.join(ROOT, rows))
    with open(os.path.join(ROOT, rows)) as f:
        new = sum(1 for line in f if line.strip())
    if new < MIN_NEW_ROWS:
        log(f"only {new} new outcome rows since {state['labeled_until']}; waiting for more runs")
        return None
    data = os.path.join(DATA, f"train-v{n}.jsonl")
    # Label files every version keeps (Jev's answers on Laya's own states, say), where they exist yet.
    extra = [f for f in state.get("extra", []) if os.path.exists(os.path.join(ROOT, f))]
    code, out = sh(["nice", "-n", "19", sys.executable, "training/build_set.py", "--out", data, state["set"], *extra, rows])
    if code:
        log(f"building {data} failed: {out[-300:]}")
        return None
    log(f"{name}: {out.splitlines()[-2].strip() if len(out.splitlines()) > 1 else out}")
    state.update(next=n + 1, set=data, labeled_until=stamp(now - OVERLAP))
    return {"name": name, "data": data}


def round_once():
    state = load()
    kernels = sessions()
    if kernels is None:
        log("the Kaggle CLI did not answer; next round")
        return
    # 1. Finished trainings come home and go on the lanes.
    for name in list(state.get("pushed", [])):
        st = kernels.get(kernel(state, name), "unknown")
        if st == "complete":
            # A run that failed in a pair's kernel has no checkpoint to fetch: left out, not tried again.
            state["pushed"].remove(name)
            if fetch(state, name):
                evaluate(state, name)
            else:
                state.setdefault("failed", []).append(name)
        elif st in ("error", "cancelled", "cancelacknowledged"):
            log(f"{name}: the kernel ended with {st}; left out")
            state["pushed"].remove(name)
            state.setdefault("failed", []).append(name)
        save(state)
    # 2. A free GPU session trains the next version.
    busy = sum(1 for s in kernels.values() if s in ("running", "queued"))
    left = quota_left()
    if busy >= 2:
        log(f"both GPU sessions busy ({', '.join(k for k, s in kernels.items() if s in ('running', 'queued'))})")
    elif left is not None and left < QUOTA_HOURS:
        log(f"{left:.1f} GPU hours left this week: not enough for a training")
    else:
        if not state.get("queue"):
            job = build_next(state)
            if job:
                state.setdefault("queue", []).append(job)
                save(state)
        if state.get("queue"):
            # Two versions share one session when two wait: a kernel has two T4s, one for each.
            jobs = state["queue"][:2]
            pair = ["--pair", jobs[1]["name"], "--pair-data", jobs[1]["data"]] if len(jobs) == 2 else []
            # train_args: kaggle.py options for every version (3 epochs: the fourth added 0.002 held-out agreement to v9a).
            code, out = sh([sys.executable, "training/kaggle.py", "train", "--name", jobs[0]["name"], "--data", jobs[0]["data"], *pair,
                            *state.get("train_args", [])])
            names = [j["name"] for j in jobs]
            if code:
                log(f"{' and '.join(names)}: push failed: {out[-300:]}")
            else:
                log(f"{' and '.join(names)}: training on Kaggle in one session ({left if left is not None else '?'} GPU hours left)")
                del state["queue"][: len(jobs)]
                state.setdefault("pushed", []).extend(names)
                for n in names:
                    state.setdefault("kernels", {})[n] = f"{names[0]}-train"
            save(state)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--every", type=float, default=10, help="minutes between rounds")
    args = ap.parse_args()
    while True:
        try:
            round_once()
        except Exception as err:  # a bad round must not end the loop
            log(f"round failed: {err!r}")
        if args.once:
            return
        time.sleep(args.every * 60)


if __name__ == "__main__":
    sys.exit(main())
