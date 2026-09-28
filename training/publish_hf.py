#!/usr/bin/env python3
"""Uploads the duel labels and fine-tuned checkpoints to Hugging Face, as private repos.

    .laya/venv/bin/python training/publish_hf.py dataset --card docs/hf/neo-vs-morpheus-duel.md
    .laya/venv/bin/python training/publish_hf.py model training/checkpoints/neo-duel --tag v1 --card docs/hf/laya-neo-duel.md

HF_TOKEN comes from the environment or the repo's .env. Repos are created private; making one
public is a deliberate step on the Hub. --dry-run assembles the upload in a local folder instead.
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
    sys.exit("no HF_TOKEN: create a write token at https://huggingface.co/settings/tokens and add it to .env")


def dataset_folder(args, out):
    """data/train.jsonl and data/test.jsonl (training/split.py output) plus the dataset card."""
    os.makedirs(os.path.join(out, "data"))
    for split in ("train", "test"):
        src = os.path.join(ROOT, getattr(args, split))
        with open(src) as f, open(os.path.join(out, "data", f"{split}.jsonl"), "w") as g:
            for line in f:
                if line.strip():
                    row = json.loads(line)
                    p = row["teacher"]["probabilities"]
                    row["teacher_choice"] = max(p, key=p.get)
                    g.write(json.dumps(row) + "\n")
    shutil.copy(os.path.join(ROOT, args.card), os.path.join(out, "README.md"))


def model_folder(args, out):
    """The checkpoint in Laya's layout plus the model card."""
    shutil.copytree(os.path.join(ROOT, args.checkpoint), out, dirs_exist_ok=True)
    shutil.copy(os.path.join(ROOT, args.card), os.path.join(out, "README.md"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="kind", required=True)
    d = sub.add_parser("dataset")
    d.add_argument("--repo", default="hakkisagdic/neo-vs-morpheus-duel")
    d.add_argument("--train", default="training/data/train.jsonl")
    d.add_argument("--test", default="training/data/test.jsonl")
    d.add_argument("--card", required=True)
    m = sub.add_parser("model")
    m.add_argument("checkpoint")
    m.add_argument("--repo", default="hakkisagdic/laya-neo-duel")
    m.add_argument("--tag", help="also tag this upload, e.g. v1")
    m.add_argument("--card", required=True)
    for p in (d, m):
        p.add_argument("--dry-run", metavar="DIR", help="assemble the upload in DIR and stop")
    args = ap.parse_args()

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
