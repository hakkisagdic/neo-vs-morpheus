#!/usr/bin/env python3
"""Uploads the duel labels and fine-tuned checkpoints to Hugging Face, as private repos.

    .laya/venv/bin/python training/publish_hf.py backup    # after every labeling run
    .laya/venv/bin/python training/publish_hf.py dataset --card docs/hf/neo-vs-morpheus-duel.md
    .laya/venv/bin/python training/publish_hf.py model training/checkpoints/neo-duel --tag v1 --card docs/hf/laya-neo-duel.md

HF_TOKEN comes from the environment, the repo's .env, or `hf auth login`. Repos are created
private; making one public is a deliberate step on the Hub. --dry-run assembles the upload in a
local folder instead.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def token():
    if os.environ.get("HF_TOKEN"):
        return os.environ["HF_TOKEN"]
    env = os.path.join(ROOT, ".env")
    if os.path.exists(env):
        with open(env) as f:
            for line in f:
                if line.startswith("HF_TOKEN="):
                    return line.split("=", 1)[1].strip()
    from huggingface_hub import get_token

    if get_token():  # `hf auth login`
        return get_token()
    sys.exit("no HF_TOKEN: run `hf auth login`, or add a write token (https://huggingface.co/settings/tokens) to .env")


# Dataset configs: name -> (train, test) as training/split.py writes them. A config whose files
# are missing is left out.
CONFIGS = {
    "mage": ("training/data/train.jsonl", "training/data/test.jsonl"),
    "melee": ("training/data/train-melee.jsonl", "training/data/test-melee.jsonl"),
    "movement": ("training/data/train-movement.jsonl", "training/data/test-movement.jsonl"),
}


def dataset_folder(args, out):
    """data/<config>/{train,test}.jsonl for every config with files, plus the dataset card."""
    for config, paths in CONFIGS.items():
        if not all(os.path.exists(os.path.join(ROOT, p)) for p in paths):
            continue
        os.makedirs(os.path.join(out, "data", config))
        for split, src in zip(("train", "test"), paths):
            with open(os.path.join(ROOT, src)) as f, open(os.path.join(out, "data", config, f"{split}.jsonl"), "w") as g:
                for line in f:
                    if line.strip():
                        row = json.loads(line)
                        p = row["teacher"]["probabilities"]
                        row["teacher_choice"] = max(p, key=p.get)
                        g.write(json.dumps(row) + "\n")
        print(f"{config}: {paths[0]}, {paths[1]}")
    shutil.copy(os.path.join(ROOT, args.card), os.path.join(out, "README.md"))


def model_folder(args, out):
    """The checkpoint in Laya's layout plus the model card."""
    shutil.copytree(os.path.join(ROOT, args.checkpoint), out, dirs_exist_ok=True)
    shutil.copy(os.path.join(ROOT, args.card), os.path.join(out, "README.md"))


ARCHIVE_README = """---
license: other
---
# neo-vs-morpheus raw archive (private, never public)

Everything the labels were made from, as it was on the machine that made it: FreeJev labels
with the teacher's full probabilities, sampled states, splits, and the run logs states come from.
FreeJev is a third-party Jev-compatible API, not affiliated with TypeSafe; its answers report
typesafe/jev-1.13-20260917, which has not been verified. The labels cost FreeJev credits and exist
nowhere else. Each backup is a commit, so the history keeps every earlier version. Published
datasets are cut from here; this repo itself stays private.

- `data/`: training/data: labels, states and training sets; `data/composite-4/` holds the labels
  carried over to composite-4 questions and the v8 training sets. train-<tag>.jsonl trained the
  model neo-duel-<tag> (hakkisagdic/laya-neo-duel).
- `trained/<run>.jsonl`: the exact training set of each run, uploaded when the run starts.
- `runs/`: every recorded match, from every machine (<instance>--<stamp>.json).
"""


def backup(args):
    """training/data and runs/ to a private dataset repo. Unchanged files are not uploaded again."""
    from huggingface_hub import HfApi

    api = HfApi(token=token())
    api.create_repo(args.repo, repo_type="dataset", private=True, exist_ok=True)
    if not api.repo_info(args.repo, repo_type="dataset").private:
        sys.exit(f"{args.repo} is public; the archive must stay private")
    if not api.file_exists(args.repo, "README.md", repo_type="dataset"):
        api.upload_file(path_or_fileobj=ARCHIVE_README.encode(), path_in_repo="README.md", repo_id=args.repo,
                        repo_type="dataset", commit_message="Describe the archive")
    for local, patterns in (("training/data", ["*.jsonl", "*.jsonl.gz"]), ("runs", ["*.json"])):
        api.upload_folder(repo_id=args.repo, repo_type="dataset", folder_path=os.path.join(ROOT, local),
                          path_in_repo=os.path.basename(local), allow_patterns=patterns,
                          commit_message=f"Back up {local}")
    print(f"backed up to https://huggingface.co/datasets/{args.repo} (private)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="kind", required=True)
    b = sub.add_parser("backup", help="labels, states and run logs to a private archive")
    b.add_argument("--repo", default="hakkisagdic/neo-vs-morpheus-raw")
    d = sub.add_parser("dataset")
    d.add_argument("--repo", default="hakkisagdic/neo-vs-morpheus-duel")
    d.add_argument("--card", required=True)
    m = sub.add_parser("model")
    m.add_argument("checkpoint")
    m.add_argument("--repo", default="hakkisagdic/laya-neo-duel")
    m.add_argument("--tag", help="also tag this upload, e.g. v1")
    m.add_argument("--card", required=True)
    for p in (d, m):
        p.add_argument("--dry-run", metavar="DIR", help="assemble the upload in DIR and stop")
    args = ap.parse_args()
    if args.kind == "backup":
        return backup(args)

    if args.dry_run:
        if os.path.exists(args.dry_run):
            sys.exit(f"{args.dry_run} exists")
        folder = args.dry_run
    else:
        tmp = tempfile.mkdtemp(prefix="hf-")
        folder = os.path.join(tmp, "upload")
    (dataset_folder if args.kind == "dataset" else model_folder)(args, folder)
    if args.dry_run:
        print(f"assembled {folder}; nothing uploaded")
        return

    from huggingface_hub import HfApi

    api = HfApi(token=token())
    repo_type = "dataset" if args.kind == "dataset" else "model"
    api.create_repo(args.repo, repo_type=repo_type, private=True, exist_ok=True)
    commit = api.upload_folder(repo_id=args.repo, repo_type=repo_type, folder_path=folder,
                               commit_message=f"Upload {os.path.basename(getattr(args, 'checkpoint', 'labels'))}")
    if getattr(args, "tag", None):
        api.create_tag(args.repo, repo_type=repo_type, tag=args.tag, revision=commit.oid, exist_ok=True)
    shutil.rmtree(tmp)
    print(f"uploaded to https://huggingface.co/{'datasets/' if repo_type == 'dataset' else ''}{args.repo} (private)")


if __name__ == "__main__":
    main()
