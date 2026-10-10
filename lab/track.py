#!/usr/bin/env python3
"""The project's experiment record in MLflow: a local SQLite store in .fleet/mlflow, no server.

    .mlflow/bin/python lab/track.py sync [NAME ...]   # record versions (every one found, by default)
    .mlflow/bin/python lab/track.py show              # every version: data, training, live result

One run per version (checkpoint) in the experiment "laya-neo-duel", named after it, rebuilt from what
is on disk, so a sync can run any number of times:
- params, which never change: the training set, its rows by teacher and module, epochs, items, the
  hardware it trained on, the Kaggle kernel;
- metrics: held-out agreement with the teacher before and after training, each epoch's when the
  training log was kept (.fleet/kaggle-logs/NAME.log), training seconds, and the live result against
  the scripted bot at matched speed next to the champion over the same hours (lab/trainer.py's gate);
- tags: the status (champion, candidate, promoted, dropped, replaced, dethroned, failed) and the
  gate's verdict.

MLflow lives in its own environment: uv venv .mlflow --python 3.12 && uv pip install --python
.mlflow/bin/python mlflow
"""
import json
import os
import re
import sys
from collections import Counter

os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
STORE = os.path.join(ROOT, ".fleet", "mlflow")
CHECKPOINTS = os.path.join(ROOT, "training", "checkpoints")
DATA = os.path.join(ROOT, "training", "data")
LOGS = os.path.join(ROOT, ".fleet", "kaggle-logs")
#: Logs of the trainings run on this Mac's GPU (training/finetune.py's output, kept by hand or by a lab script).
LOCAL_LOGS = os.path.join(ROOT, ".fleet", "train")
STATE = os.path.join(ROOT, ".fleet", "trainer.json")
EXPERIMENT = "laya-neo-duel"
#: Sets whose file name does not follow train-<short>.jsonl (short: the name without "neo-duel-").
SETS = {
    "neo-duel-v8": "composite-4/train-v8.jsonl",
    "neo-duel-v8-dagger-all": "composite-4/train-v8-dagger-all.jsonl",
    "neo-duel-v8r": "composite-4/train-v8.jsonl",
    "neo-duel-v8r-s2": "composite-4/train-v8.jsonl",
    "neo-skill-v1": "skill-mix-v1.jsonl",
}
#: Recipes in words, for the versions before the trainer kept them.
RECIPES = {
    "neo-duel-v8": "FreeJev labels + outcome rows (composite-4)",
    "neo-duel-v8-dagger-all": "v8 + DAgger rows from the scripted bot, every module",
    "neo-duel-v8r": "v8's set again, today's Kaggle pipeline (reproduction)",
    "neo-duel-v8r-s2": "v8's set again, today's Kaggle pipeline, seed 2 (reproduction)",
    "neo-duel-v9a": "v8 + 17k outcome rows + 5.4k melee DAgger rows",
    "neo-duel-v10": "v9a's outcome rows + 20k newer outcome rows, no DAgger (cancelled)",
    "neo-duel-v10b": "v8 + Laya's own outcome rows only (outcome:laya)",
    "neo-duel-v11j": "v8 + Jev's answers on v8's own states (DAgger with Jev)",
    "neo-skill-v1": "from v8s4: 8000 sampled skill-training states answered by the oracle trainer (RunUO's Magery odds), "
                    "4000 of v8's duel rows against forgetting",
}


def mlflow_client():
    import mlflow

    os.makedirs(STORE, exist_ok=True)
    mlflow.set_tracking_uri(f"sqlite:///{os.path.join(STORE, 'mlflow.db')}")
    if mlflow.get_experiment_by_name(EXPERIMENT) is None:
        mlflow.create_experiment(EXPERIMENT, artifact_location=os.path.join(STORE, "artifacts"))
    mlflow.set_experiment(EXPERIMENT)
    return mlflow


def set_of(name):
    path = SETS.get(name) or f"train-{name.removeprefix('neo-duel-')}.jsonl"
    return os.path.join(DATA, path)


def composition(path):
    """Rows of a training set by teacher and by module."""
    teachers, modules = Counter(), Counter()
    if not os.path.exists(path):
        return teachers, modules
    with open(path) as f:
        for line in f:
            if not line.strip():
                continue
            row = json.loads(line)
            t = row.get("teacher")
            model = t.get("model", "?") if isinstance(t, dict) else str(t)
            teachers["FreeJev" if model.startswith("typesafe/") else model] += 1
            modules[row.get("module", "mage")] += 1
    return teachers, modules


def local_log(name):
    """The log of a training run on this Mac, if it was one."""
    path = os.path.join(LOCAL_LOGS, f"{name}.log")
    return path if os.path.exists(path) else None


def epochs_from_log(name):
    """Each epoch's held-out agreement and soft CE from a kept training log (pairs prefix lines with [name])."""
    path = local_log(name) or os.path.join(LOGS, f"{name}.log")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        text = f.read()
    return [(int(e), float(a), float(c)) for e, a, c in re.findall(r"epoch (\d+)/\d+:.*held-out agreement ([\d.]+), soft CE ([\d.]+)", text)]


def outcome(state, name):
    """The gate's verdict on a version: status and the numbers in it."""
    if name == state.get("champion"):
        status = "champion"
    elif name in state.get("candidates", {}).values():
        status = "candidate"
    elif name in state.get("failed", []):
        status = "failed"
    else:
        status = None
    verdict = None
    for h in state.get("history", []):
        if name in (h.get("promoted"), h.get("dropped"), h.get("replaced")):
            status = status or ("promoted" if h.get("promoted") == name else "dropped" if h.get("dropped") == name else "replaced")
            verdict = h.get("result")
    # A former champion, beaten by a version promoted over it, whatever got it there.
    if status in (None, "promoted") and any(h.get("over") == name for h in state.get("history", [])):
        status = "dethroned"
    numbers = {}
    m = re.search(r"(\d+)% \((\d+)-(\d+)\) against (\S+) (\d+)% \((\d+)-(\d+)\)(?:, z ([-+.\d]+))?", verdict or "")
    if m:
        numbers = {"live_share": int(m[1]) / 100, "live_wins": int(m[2]), "live_losses": int(m[3]),
                   "champion_share": int(m[5]) / 100, "champion_wins": int(m[6]), "champion_losses": int(m[7])}
        if m[8]:
            numbers["z"] = float(m[8])
    return status, verdict, numbers


def sync(names):
    mlflow = mlflow_client()
    state = json.load(open(STATE)) if os.path.exists(STATE) else {}
    for name in names:
        config_path = os.path.join(CHECKPOINTS, name, "rl_agent_config.json")
        training = json.load(open(config_path)).get("training", {}) if os.path.exists(config_path) else {}
        runs = mlflow.search_runs(filter_string=f"attributes.run_name = '{name}'", output_format="list")
        with mlflow.start_run(run_id=runs[0].info.run_id) if runs else mlflow.start_run(run_name=name):
            run = mlflow.active_run()
            known = set(run.data.params)
            params = {}
            data = set_of(name)
            teachers, modules = composition(data)
            if teachers:
                params.update({"set": os.path.relpath(data, ROOT), "rows": sum(teachers.values())})
                params.update({f"rows.{k}": v for k, v in teachers.items()})
                params.update({f"module.{k}": v for k, v in modules.items()})
            if training:
                seconds, items = training.get("seconds", 0), training.get("items", 0)
                hardware = "M5 Max (MPS, this Mac)" if local_log(name) else "A100 (Colab)" if items and seconds / items < 0.1 else "T4 (Kaggle)"
                params.update({"epochs": training.get("epochs"), "items": items, "mode": training.get("mode"), "hardware": hardware,
                               **({"init": training["init"]} if training.get("init") else {})})
            if name in RECIPES:
                params["recipe"] = RECIPES[name]
            if name in state.get("kernels", {}):
                params["kaggle_kernel"] = state["kernels"][name]
            mlflow.log_params({k: v for k, v in params.items() if k not in known and v is not None})
            if training.get("held_out_agreement"):
                before, after = training["held_out_agreement"]
                mlflow.log_metrics({"held_out_before": before, "held_out_after": after, "train_seconds": training.get("seconds", 0)})
            for epoch, agreement, ce in epochs_from_log(name):
                mlflow.log_metrics({"held_out_epoch": agreement, "soft_ce_epoch": ce}, step=epoch)
            status, verdict, numbers = outcome(state, name)
            if numbers:
                mlflow.log_metrics(numbers)
            mlflow.set_tags({k: v for k, v in {"status": status, "verdict": verdict}.items() if v})
        print(f"{name}: {status or 'no verdict yet'}{f' ({verdict})' if verdict else ''}")


def show():
    mlflow = mlflow_client()
    rows = mlflow.search_runs(output_format="list", order_by=["attributes.run_name ASC"])
    for r in rows:
        p, m, t = r.data.params, r.data.metrics, r.data.tags
        live = f"{m['live_share']:.0%} vs {m['champion_share']:.0%}" if "live_share" in m else "—"
        print(f"{r.info.run_name:22s} {t.get('status', '—'):9s} rows {p.get('rows', '?'):>6s}  epochs {p.get('epochs', '?')}  "
              f"{p.get('hardware', '?'):12s} held-out {m.get('held_out_after', float('nan')):.3f}  live {live}  {p.get('recipe', '')}")


def main():
    command, *names = sys.argv[1:] or ["show"]
    if command == "sync":
        names = names or sorted(d for d in os.listdir(CHECKPOINTS) if d.startswith(("neo-duel-", "neo-skill-")))
        state = json.load(open(STATE)) if os.path.exists(STATE) else {}
        names = sorted(set(names) | set(state.get("failed", [])) if not sys.argv[2:] else set(names))
        sync(names)
    elif command == "show":
        show()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
