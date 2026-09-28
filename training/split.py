#!/usr/bin/env python3
"""Splits teacher labels into a training file and a fixed test set that no checkpoint trains on.

    python3 training/split.py --exclude training/data/neo-duel-v1-labeled.jsonl.gz

A label is held out when an earlier checkpoint did not train on it (it is not in --exclude) and
the SHA-1 of its id falls in one of --every buckets, so the same labels always land in the same
file and old and new checkpoints are compared on the same states (`npm run nvm -- distill agree`).
"""
import argparse
import gzip
import hashlib
import json

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--labels", default="training/data/labeled.jsonl")
ap.add_argument("--exclude", help="labels an earlier checkpoint trained on (.jsonl or .jsonl.gz); never held out")
ap.add_argument("--every", type=int, default=25, help="about one in this many new labels is held out")
ap.add_argument("--train", default="training/data/train.jsonl")
ap.add_argument("--test", default="training/data/test.jsonl")
args = ap.parse_args()

seen = set()
if args.exclude:
    with (gzip.open if args.exclude.endswith(".gz") else open)(args.exclude, "rt") as f:
        seen = {json.loads(line)["id"] for line in f if line.strip()}
counts = [0, 0]
with open(args.labels) as f, open(args.train, "w") as train, open(args.test, "w") as test:
    for line in f:
        if not line.strip():
            continue
        key = json.loads(line)["id"]
        held = key not in seen and int(hashlib.sha1(key.encode()).hexdigest(), 16) % args.every == 0
        (test if held else train).write(line)
        counts[held] += 1
print(f"{counts[0]} for training -> {args.train}, {counts[1]} held out -> {args.test}")
