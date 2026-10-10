#!/usr/bin/env python3
"""Keeps every planned lane busy: whenever one goes idle, it starts the lane's series again.

    python3 lab/keeper.py                  # every 5 minutes, until stopped
    python3 lab/keeper.py --once           # one look, for a cron or a test

The plan is .fleet/plan.json (git-ignored; lab/plan.example.json shows the shape): per machine, the
lanes to keep busy, each with its series file and, on a GPU machine, its model and arenas:

    {"mac": [{"lane": 0, "series": ".fleet/mac/series/explore36.json", "model": "neo-duel-v8"}],
     "alastyr": [{"lane": 1, "series": "lab/series-rules-variety-b.json"}]}

A lane that is running is left alone; one the plan does not name is never touched. Edit the plan
while the keeper runs: it is read again on every round. Standard library only; it drives the fleet
CLI (npm run nvm -- fleet status/start), so it sees what the dashboard sees.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BOT = os.path.join(ROOT, "bot")
PLAN = os.path.join(ROOT, ".fleet", "plan.json")


def fleet(*args):
    out = subprocess.run(["npm", "run", "-s", "nvm", "--", "fleet", *args], cwd=BOT, capture_output=True, text=True, timeout=1800)
    return out.returncode, (out.stdout + out.stderr).strip()


def idle_lanes(machine):
    """Lane numbers the machine reports idle ("lane 3 [model]: idle, …"), and running ones."""
    code, text = fleet("status", machine)
    if code:
        return None, text
    idle = {int(m) for m in re.findall(r"^lane (\d+) \[[^\]]*\]: idle", text, re.M)}
    running = {int(m) for m in re.findall(r"^lane (\d+) \[[^\]]*\]: running", text, re.M)}
    return (idle, running), text


def round_once():
    try:
        with open(PLAN) as f:
            plan = json.load(f)
    except (OSError, ValueError) as err:
        print(f"{time.strftime('%H:%M')} no usable plan at {PLAN}: {err}", flush=True)
        return
    seen = []
    for machine, lanes in plan.items():
        state, text = idle_lanes(machine)
        if state is None:
            print(f"{time.strftime('%H:%M')} {machine}: status failed: {text[-200:]}", flush=True)
            continue
        idle, running = state
        seen.append(f"{machine} {sum(lane['lane'] in running for lane in lanes)}/{len(lanes)}")
        for lane in lanes:
            n = lane["lane"]
            if n in running:
                continue
            # A lane never started has no log yet, so it is neither idle nor running: start it too.
            args = ["start", machine, lane["series"], "--lane", str(n)]
            if lane.get("model"):
                args += ["--model", lane["model"]]
            if lane.get("model_b"):  # a sparring partner for the series' "laya-b" fighters
                args += ["--model-b", lane["model_b"]]
            if lane.get("parallel"):
                args += ["--parallel", str(lane["parallel"])]
            code, out = fleet(*args)
            print(f"{time.strftime('%H:%M')} {machine} lane {n}: {out.splitlines()[-1] if out else code}", flush=True)
    # One line a round, so that a quiet keeper is seen to be alive: planned lanes running per machine.
    print(f"{time.strftime('%H:%M')} running: {', '.join(seen)}", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--every", type=float, default=5, help="minutes between rounds")
    args = ap.parse_args()
    while True:
        round_once()
        if args.once:
            return
        time.sleep(args.every * 60)


if __name__ == "__main__":
    sys.exit(main())
