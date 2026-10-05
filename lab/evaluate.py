#!/usr/bin/env python3
"""Put a checkpoint on this Mac's lanes against the scripted bot at matched speed, next to the
model it should beat, and keep both lanes playing (the keeper restarts them from the plan):

    python3 lab/evaluate.py --model neo-duel-v9a --lane 2 --baseline neo-duel-v8 --baseline-lane 1 --wait

--wait first waits for the checkpoint to come home (training/kaggle.py fetch puts it in
training/checkpoints/<model>). The lanes play the same series at the same time, so the two rows on
the panel's Models card compare like with like; a lane that was busy is stopped first. The plan in
.fleet/plan.json gets the lanes, so a series that ends starts again until the plan changes.
Standard library only.
"""
import argparse
import json
import os
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BOT = os.path.join(ROOT, "bot")
PLAN = os.path.join(ROOT, ".fleet", "plan.json")
SERIES = os.path.join(ROOT, ".fleet", "mac", "series", "matched40x3.json")


def fleet(*args):
    out = subprocess.run(["npm", "run", "-s", "nvm", "--", "fleet", *args], cwd=BOT, capture_output=True, text=True, timeout=3600)
    text = (out.stdout + out.stderr).strip()
    print(text.splitlines()[-1] if text else f"fleet {' '.join(args)}: exit {out.returncode}", flush=True)
    return out.returncode


def put(lane, model, series):
    """The plan names the lane's series and model; the lane restarts with them now."""
    with open(PLAN) as f:
        plan = json.load(f)
    lanes = [l for l in plan.setdefault("mac", []) if l["lane"] != lane]
    lanes.append({"lane": lane, "series": series, "model": model})
    plan["mac"] = sorted(lanes, key=lambda l: l["lane"])
    with open(f"{PLAN}.tmp", "w") as f:
        json.dump(plan, f, indent=1)
    os.replace(f"{PLAN}.tmp", PLAN)
    fleet("stop", "mac", "--lane", str(lane))
    return fleet("start", "mac", series, "--lane", str(lane), "--model", model)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True)
    ap.add_argument("--lane", type=int, required=True)
    ap.add_argument("--baseline", help="the model to beat, on its own lane at the same time")
    ap.add_argument("--baseline-lane", type=int)
    ap.add_argument("--series", default=SERIES)
    ap.add_argument("--wait", action="store_true", help="wait until the checkpoint is on this Mac")
    args = ap.parse_args()
    if args.baseline and args.baseline_lane is None:
        sys.exit("--baseline needs --baseline-lane")

    config = os.path.join(ROOT, "training", "checkpoints", args.model, "rl_agent_config.json")
    while args.wait and not os.path.exists(config):
        time.sleep(60)
    if not os.path.exists(config):
        print(f"no checkpoint at training/checkpoints/{args.model}; the lane fetches the published one", flush=True)
    failed = put(args.lane, args.model, args.series)
    if args.baseline:
        failed |= put(args.baseline_lane, args.baseline, args.series)
    print(f"{time.strftime('%H:%M')} {args.model} on lane {args.lane}" + (f", {args.baseline} on lane {args.baseline_lane}" if args.baseline else ""), flush=True)
    return failed


if __name__ == "__main__":
    sys.exit(main())
