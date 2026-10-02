"""Keep each training set next to the model it trains, in the private Hugging Face archive.

The trainers (colab.py, kaggle.py) call archive() when they start a run: the exact file goes to
trained/<run name>.jsonl, so every model tag in the model repo has its data under the same name.
Standard library only; the upload goes through the hf CLI and its login (`hf auth login`).
"""
import os
import shutil
import subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_REPO = "hakkisagdic/neo-vs-morpheus-raw"  # the private archive publish_hf.py backs up to


def hf_cli():
    for path in (shutil.which("hf"), os.path.join(ROOT, ".laya", "venv", "bin", "hf")):
        if path and os.path.exists(path):
            return path
    return None


def archive(path, name, repo=DATA_REPO):
    """Upload the training file of run `name`. A failed upload warns but does not stop the run."""
    hf = hf_cli()
    if not hf:
        print(f"WARNING: no hf CLI, so {path} was not archived to {repo}; `hf auth login` and upload it by hand")
        return
    out = subprocess.run([hf, "upload", repo, path, f"trained/{name}.jsonl", "--repo-type", "dataset", "--private",
                          "--commit-message", f"Training set for {name}"], capture_output=True, text=True)
    if out.returncode:
        print(f"WARNING: archiving {path} to {repo} failed: {(out.stderr or out.stdout).strip()[-300:]}")
    else:
        print(f"training set -> https://huggingface.co/datasets/{repo} (private), trained/{name}.jsonl")
