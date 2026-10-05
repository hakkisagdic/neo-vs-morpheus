#!/usr/bin/env python3
"""Join label files into one training set, without repeating a row.

    python3 training/build_set.py --out training/data/train-v9a.jsonl \\
        training/data/composite-4/train-v8.jsonl training/data/labeled-outcome.jsonl \\
        training/data/labeled-dagger-runs.jsonl:melee

A `file:module` source keeps only that module's rows (mage or melee). A row repeats another when it
has the same state, the same teacher and the same module; the later source wins, so list the
older data first. Rows in an older question format than the newest in the set are left out, since
a model is served with one format. Prints what each source added and the teachers in the result.
Standard library only.
"""
import argparse
import json
import os
from collections import Counter


def teacher_name(row):
    t = row.get("teacher")
    model = t.get("model", "?") if isinstance(t, dict) else str(t)
    return "FreeJev" if model.startswith("typesafe/") else model


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sources", nargs="+", help="label files, oldest first; file:mage or file:melee keeps one module")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    rows = {}
    added = []
    for source in args.sources:
        path, _, module = source.partition(":")
        n = 0
        with open(path) as f:
            for line in f:
                if not line.strip():
                    continue
                row = json.loads(line)
                if module and row.get("module", "mage") != module:
                    continue
                key = (row["state"], teacher_name(row), row.get("module", "mage"))
                rows.pop(key, None)  # the later source wins, and moves to the end
                rows[key] = row
                n += 1
        added.append((source, n))

    # One question format per module: the newest one present.
    newest = {}
    for row in rows.values():
        fmt = row.get("format") or {}
        newest[row.get("module", "mage")] = max(newest.get(row.get("module", "mage"), ""), fmt.get("question", ""))
    kept = [r for r in rows.values() if (r.get("format") or {}).get("question", "") == newest[r.get("module", "mage")]]

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        for row in kept:
            f.write(json.dumps(row) + "\n")
    for source, n in added:
        print(f"{n:7d} rows from {source}")
    teachers = Counter(teacher_name(r) for r in kept)
    modules = Counter(r.get("module", "mage") for r in kept)
    print(f"{len(kept):7d} rows -> {args.out} ({len(rows) - len(kept)} in older formats left out)")
    print("        teachers:", ", ".join(f"{k} {v}" for k, v in teachers.most_common()), "| modules:", dict(modules))


if __name__ == "__main__":
    main()
