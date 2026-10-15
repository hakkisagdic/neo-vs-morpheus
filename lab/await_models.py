#!/usr/bin/env python3
"""Waits for checkpoints trained elsewhere (a Colab VM) to reach the models repo on Hugging Face,
then hands them to the trainer as candidates through its inbox (.fleet/trainer-inbox.json):

    python3 lab/await_models.py neo-v10s1 neo-v10s2 --skills [--eval-lanes 0,3,2,4]
    python3 lab/await_models.py neo-v12m3-s1 --skills magery,necromancy,chivalry

--skills marks them as able to train skills (the gate still asks `skillcheck` for evidence): Magery alone,
or the schools named. A model trained on the champion's set must name all of the champion's, or the gate
drops it as unable to train them (neo-v12m3, 2026-10-15).
Standard library and the hf CLI only.
"""
import argparse
import json
import os
import subprocess
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REPO = "hakkisagdic/laya-neo-duel"
HF = os.path.join(ROOT, ".laya", "venv", "bin", "hf")


def published(tag):
    """The checkpoint's config exists at that revision of the models repo."""
    out = subprocess.run([HF, "download", REPO, "rl_agent_config.json", "--revision", tag, "--local-dir",
                          os.path.join(ROOT, ".fleet", "await", tag), "--quiet"], capture_output=True, text=True)
    return out.returncode == 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("names", nargs="+")
    ap.add_argument("--skills", nargs="?", const="magery", help="the skills they train (default magery), comma separated")
    ap.add_argument("--eval-lanes")
    ap.add_argument("--every", type=float, default=5, help="minutes between looks")
    args = ap.parse_args()
    waiting = list(args.names)
    while waiting:
        for name in list(waiting):
            if published(name):
                waiting.remove(name)
                print(f"{time.strftime('%H:%M')} {name} is on the hub", flush=True)
        if waiting:
            time.sleep(args.every * 60)
    orders = {"candidates": [{"name": n} for n in args.names]}
    if args.skills:
        orders["skills"] = {n: [s.strip() for s in args.skills.split(",") if s.strip()] for n in args.names}
    if args.eval_lanes:
        orders["eval_lanes"] = [int(x) for x in args.eval_lanes.split(",")]
    inbox = os.path.join(ROOT, ".fleet", "trainer-inbox.json")
    # Orders the trainer has not read yet are not overwritten: these wait for its next round.
    if os.path.exists(inbox):
        print(f"{time.strftime('%H:%M')} the trainer has unread orders; waiting for its next round", flush=True)
    while os.path.exists(inbox):
        time.sleep(60)
    with open(f"{inbox}.tmp", "w") as f:
        json.dump(orders, f, indent=1)
    os.replace(f"{inbox}.tmp", inbox)
    print(f"{time.strftime('%H:%M')} handed {', '.join(args.names)} to the trainer", flush=True)


if __name__ == "__main__":
    main()
