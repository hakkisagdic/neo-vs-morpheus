#!/usr/bin/env python3
"""Ships a VM's new runs to the private runs dataset, so that they outlive the VM.

A Colab or Kaggle VM can be recycled at any time, and with it every run on its disk: an A100's
evening of runs went that way. This keeps them on Hugging Face as they are made:

    HF_TOKEN=... python3 ship.py <instance> <runs-repo>            # every 10 minutes, for good
    HF_TOKEN=... python3 ship.py <instance> <runs-repo> --once     # what the fleet's pull does

Each run goes to by-day/<day>/<instance>/<instance>--<stamp>.json.gz, once (shipped.txt remembers): a
folder on the Hub holds at most 10,000 entries, files and folders alike, and colab-pro/ filled up on
2026-10-15 (the older runs stay at <instance>/). Runs still being written (they do not parse yet) wait for
the next round. The repo must be private.
"""
import argparse
import glob
import gzip
import json
import os
import re
import shutil
import time

from huggingface_hub import HfApi

A = os.environ.get("ARENA_DIR", "/content/arena")


def ship_once(api, name, repo):
    staging = os.path.join(A, "ship")
    os.makedirs(staging, exist_ok=True)
    done_file = os.path.join(A, "shipped.txt")
    shipped = set(open(done_file).read().split()) if os.path.exists(done_file) else set()
    new = []
    for path in sorted(glob.glob(os.path.join(A, "nvm", "runs", "*.json"))):
        base = os.path.basename(path)
        if base in shipped:
            continue
        try:
            with open(path) as f:
                json.load(f)
        except ValueError:
            continue
        target = base if base.startswith(name + "--") else f"{name}--{base}"
        day = re.search(r"\d{4}-\d{2}-\d{2}", base)
        folder = os.path.join(staging, day.group(0) if day else time.strftime("%Y-%m-%d"), name)
        os.makedirs(folder, exist_ok=True)
        with open(path, "rb") as src, gzip.open(os.path.join(folder, target + ".gz"), "wb") as dst:
            shutil.copyfileobj(src, dst)
        new.append(base)
    if new:
        api.upload_folder(repo_id=repo, repo_type="dataset", folder_path=staging, path_in_repo="by-day",
                          allow_patterns=["*.gz"], commit_message=f"{name}: {len(new)} runs")
        with open(done_file, "a") as f:
            f.write("\n".join(new) + "\n")
        for done in glob.glob(os.path.join(staging, "**", "*.gz"), recursive=True):
            os.remove(done)
    return len(new)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("instance")
    ap.add_argument("repo")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--minutes", type=float, default=10)
    args = ap.parse_args()
    api = HfApi(token=os.environ["HF_TOKEN"])
    api.create_repo(args.repo, repo_type="dataset", private=True, exist_ok=True)
    if not api.repo_info(args.repo, repo_type="dataset").private:
        raise SystemExit(f"{args.repo} is public; runs only go to a private repo")
    while True:
        try:
            print(f"{time.strftime('%H:%M')} shipped {ship_once(api, args.instance, args.repo)}", flush=True)
        except Exception as err:  # the network, the Hub: try again next round
            if args.once:
                raise
            print(f"{time.strftime('%H:%M')} ship failed: {err}", flush=True)
        if args.once:
            return
        time.sleep(args.minutes * 60)


if __name__ == "__main__":
    main()
