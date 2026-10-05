#!/usr/bin/env python3
"""One turn of the learning loop, end to end, with one command:

    python3 lab/iterate.py --name neo-duel-v10 --base training/data/train-v9a.jsonl \\
        --since 2026-10-05T14 --train kaggle --against neo-duel-v9a

1. pull every machine's runs into runs/ (fleet pull)
2. label the runs since --since: DAgger rows (distill dagger) and outcome rows (distill outcomes)
3. build the training set: the base set, then the outcome rows, then the DAgger rows (every one,
   or only one module's with --dagger melee)
4. train it on Kaggle (training/kaggle.py all) or on this Mac's GPU (training/finetune.py on Metal);
   either way the set is archived to Hugging Face next to the model's name
5. publish the checkpoint to the private model repo, tagged with its name
6. evaluate on this Mac against the scripted bot at matched speed (lab/series-matched12.json, rules
   at 40 ms, three times over): the new model on --lanes, --against on as many lanes after them
7. wait for the evaluation and print both rows (the panel's Fleet page shows them too)

Every step leaves a marker in .fleet/iterations/<name>/; a rerun skips the steps already done, so a
turn that stopped (a Kaggle queue, a closed laptop) picks up where it was.
"""
import argparse
import datetime
import json
import os
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BOT = os.path.join(ROOT, "bot")
PY = os.path.join(ROOT, ".laya", "venv", "bin", "python")


def sh(cmd, cwd=ROOT, log=None):
    """Runs a command, echoing its output (and keeping it in log); stops the turn when it fails."""
    print(f"$ {' '.join(cmd)}", flush=True)
    out = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    text = (out.stdout + out.stderr).strip()
    if log:
        with open(log, "a") as f:
            f.write(f"$ {' '.join(cmd)}\n{text}\n")
    print("\n".join(l for l in text.splitlines()[-6:]), flush=True)
    if out.returncode:
        sys.exit(f"failed: {' '.join(cmd)}")
    return text


def nvm(*args, log=None):
    return sh(["npm", "run", "-s", "nvm", "--", *args], cwd=BOT, log=log)


class Turn:
    def __init__(self, name):
        self.dir = os.path.join(ROOT, ".fleet", "iterations", name)
        os.makedirs(self.dir, exist_ok=True)
        self.log = os.path.join(self.dir, "turn.log")
        state = os.path.join(self.dir, "state.json")
        self.state = json.load(open(state)) if os.path.exists(state) else {}

    def save(self):
        with open(os.path.join(self.dir, "state.json"), "w") as f:
            json.dump(self.state, f, indent=1)

    def step(self, name, fn):
        if name in self.state.get("done", []):
            print(f"== {name}: done before, skipped", flush=True)
            return
        print(f"== {name}", flush=True)
        fn()
        self.state.setdefault("done", []).append(name)
        self.save()


def lanes_busy(lanes):
    out = subprocess.run(["pgrep", "-lf", "mac-series-"], capture_output=True, text=True).stdout
    return [l for l in lanes if f"mac-series-{l} " in out]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True, help="the new model, e.g. neo-duel-v10")
    ap.add_argument("--base", required=True, help="the training set to build on (oldest data)")
    ap.add_argument("--since", required=True, help="label runs from this time stamp on, e.g. 2026-10-05T14")
    ap.add_argument("--dagger", choices=["all", "mage", "melee", "none"], default="all", help="which DAgger rows to add")
    ap.add_argument("--train", choices=["kaggle", "mac"], default="kaggle")
    ap.add_argument("--against", help="a published model to evaluate side by side, e.g. neo-duel-v9a")
    ap.add_argument("--lanes", default="0,1", help="this Mac's lanes for the new model (as many follow for --against)")
    ap.add_argument("--series", default="lab/series-matched12.json")
    ap.add_argument("--repeat", type=int, default=3, help="times the evaluation series is played")
    args = ap.parse_args()

    turn = Turn(args.name)
    short = args.name.removeprefix("neo-duel-")
    data = os.path.join("training", "data", f"train-{short}.jsonl")
    checkpoint = os.path.join("training", "checkpoints", args.name)

    turn.step("pull", lambda: nvm("fleet", "pull", log=turn.log))
    turn.step("label", lambda: (nvm("distill", "dagger", args.since, log=turn.log), nvm("distill", "outcomes", args.since, log=turn.log)))

    def build():
        dagger = os.path.join("training", "data", "labeled-dagger-runs.jsonl")
        sources = [args.base, os.path.join("training", "data", "labeled-outcome.jsonl")]
        if args.dagger != "none":
            sources.append(dagger if args.dagger == "all" else f"{dagger}:{args.dagger}")
        sh([sys.executable, "training/build_set.py", "--out", data, *sources], log=turn.log)

    turn.step("build", build)

    def train():
        if args.train == "kaggle":
            sh([sys.executable, "training/kaggle.py", "all", "--name", args.name, "--data", data], log=turn.log)
        else:
            sh([PY, "-c", f"import sys; sys.path.insert(0, 'training'); from hfdata import archive; archive({data!r}, {args.name!r})"], log=turn.log)
            # Written as it goes, where the panel's Training card follows it.
            log = os.path.join(ROOT, ".fleet", "train", f"{args.name}.log")
            os.makedirs(os.path.dirname(log), exist_ok=True)
            print(f"$ training/finetune.py (log: {log})", flush=True)
            with open(log, "w") as f:
                code = subprocess.run([PY, "-u", "training/finetune.py", "--mode", "top", "--data", data, "--out", checkpoint, "--train-top-layers", "28",
                                       "--epochs", "4", "--batch", "16", "--accum", "4", "--holdout", "0.05", "--no-checkpointing"],
                                      cwd=ROOT, stdout=f, stderr=subprocess.STDOUT).returncode
            if code:
                sys.exit(f"failed: training/finetune.py, see {log}")

    turn.step("train", train)
    turn.step("publish", lambda: sh([PY, "training/publish_hf.py", "model", checkpoint, "--tag", args.name, "--card", "docs/hf/laya-neo-duel.md"], log=turn.log))

    lanes = [int(x) for x in args.lanes.split(",")]
    against = [l + len(lanes) for l in lanes] if args.against else []

    def evaluate():
        with open(os.path.join(ROOT, args.series)) as f:
            entries = json.load(f)
        series = os.path.join(turn.dir, f"eval-{os.path.basename(args.series)}")
        with open(series, "w") as f:
            json.dump(entries * args.repeat, f, indent=1)
        turn.state["eval_since"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
        turn.save()
        for lane, model in [(l, args.name) for l in lanes] + [(l, args.against) for l in against]:
            nvm("fleet", "stop", "mac", "--lane", str(lane), log=turn.log)
            nvm("fleet", "start", "mac", series, "--lane", str(lane), "--model", model, log=turn.log)

    turn.step("evaluate", evaluate)

    def wait():
        while busy := lanes_busy(lanes + against):
            print(f"{time.strftime('%H:%M')} evaluating on lanes {busy}", flush=True)
            time.sleep(120)

    turn.step("wait", wait)
    results = nvm("fleet", "results", "--since", turn.state["eval_since"], log=turn.log)
    rows = [l for l in results.splitlines() if args.name in l or (args.against and args.against in l)]
    print("\n".join(rows) or results)
    turn.state["results"] = rows
    turn.save()


if __name__ == "__main__":
    main()
