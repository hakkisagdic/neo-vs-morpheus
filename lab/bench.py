#!/usr/bin/env python3
"""Plays UO Bench (bench/<id>.json) for one player on this Mac's lanes:

    python3 lab/bench.py run --player laya --model neo-duel-v8r-s2 --lanes 5
    python3 lab/bench.py run --player random --lanes 6 --passes 4
    python3 lab/bench.py run --player laya --model laya-base --lanes 2 --tracks ml/duel-mage

A player is a brain as a fighter spec names it (laya, random, jev, rules@N); a laya player plays the
checkpoint --model on the lane's Laya server. Every match of the chosen tracks, from both seats, is
played --passes times; each is tagged with its track ("uo-bench/1:ml/duel-mage"), so its run counts
for the bench and stays out of the training loop's selection. The matches are shared out over the
lanes; when a lane's bench series ends, the keeper puts the lane back on its planned work. The scores:
npm run nvm -- leaderboard. Standard library only.
"""
import argparse
import json
import os
import random
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BOT = os.path.join(ROOT, "bot")
SERIES = os.path.join(ROOT, ".fleet", "mac", "series")


def fleet(*args):
    out = subprocess.run(["npm", "run", "-s", "nvm", "--", "fleet", *args], cwd=BOT, capture_output=True, text=True, timeout=3600)
    text = (out.stdout + out.stderr).strip()
    print(text.splitlines()[-1] if text else f"fleet {' '.join(args)}: exit {out.returncode}", flush=True)
    return out.returncode


def matches(spec, tracks, player, passes, seed):
    """Every entry of the tracks from both seats, `passes` times over, in a seeded order."""
    out = []
    for name in tracks:
        track = spec["tracks"][name]
        me = track["player"].replace("{player}", player)
        them = track["opponent"]
        for entry in track["entries"]:
            extra = {k: v for k, v in entry.items() if k != "label"}
            for first in (True, False):
                a, b = (f"Neo:{me}", f"Morpheus:{them}") if first else (f"Neo:{them}", f"Morpheus:{me}")
                out.append({"label": f"{name} {entry['label']}, the player {'first' if first else 'second'}", "a": a, "b": b,
                            "rounds": track.get("rounds", 10), **({"timeout": track["timeout"]} if "timeout" in track else {}),
                            **extra, "bench": f"{spec['id']}:{name}"})
    out = out * passes
    random.Random(seed).shuffle(out)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["run", "plan"])
    ap.add_argument("--bench", default="uo-bench-1", help="bench/<name>.json")
    ap.add_argument("--player", required=True, help="laya, random, jev or rules@N")
    ap.add_argument("--model", help="the checkpoint a laya player plays (served on each lane)")
    ap.add_argument("--lanes", required=True, help="the machine's lanes, comma-separated")
    ap.add_argument("--machine", default="mac", help="a fleet machine: mac, or a CPU-only one (alastyr) for players without a model")
    ap.add_argument("--tracks", help="comma-separated; every track of the bench by default")
    ap.add_argument("--passes", type=int, default=4, help="times every match is played")
    ap.add_argument("--parallel", type=int, default=8)
    ap.add_argument("--seed", type=int, default=20261006)
    args = ap.parse_args()
    if args.player == "laya" and not args.model:
        sys.exit("a laya player needs --model")
    if args.machine != "mac" and args.model:
        sys.exit(f"{args.machine} has no GPU: only players without a model (random, rules) play there")

    with open(os.path.join(ROOT, "bench", f"{args.bench}.json")) as f:
        spec = json.load(f)
    tracks = args.tracks.split(",") if args.tracks else list(spec["tracks"])
    unknown = [t for t in tracks if t not in spec["tracks"]]
    if unknown:
        sys.exit(f"no such tracks in {args.bench}: {', '.join(unknown)}")
    lanes = [int(x) for x in args.lanes.split(",")]
    plan = matches(spec, tracks, args.player, args.passes, args.seed)
    who = args.model or args.player.replace("@", "-at-")
    os.makedirs(SERIES, exist_ok=True)
    failed = 0
    for k, lane in enumerate(lanes):
        share = plan[k :: len(lanes)]
        path = os.path.join(SERIES, f"bench-{who}-{args.machine}-lane{lane}.json")
        with open(path, "w") as f:
            json.dump(share, f, indent=1)
        rounds = sum(m["rounds"] for m in share)
        print(f"lane {lane}: {len(share)} matches, {rounds} rounds of {', '.join(tracks)} -> {os.path.relpath(path, ROOT)}", flush=True)
        if args.command == "run":
            fleet("stop", args.machine, "--lane", str(lane))
            failed |= fleet("start", args.machine, path, "--lane", str(lane), "--parallel", str(args.parallel), *(["--model", args.model] if args.model else []))
    return failed


if __name__ == "__main__":
    sys.exit(main())
