#!/usr/bin/env python3
"""Fine-tune Laya on a Google Colab GPU through colab-bridge and bring the checkpoint home.

Needs https://github.com/hakkisagdic/colab-bridge with a Colab tab connected to it:

    uv tool install git+https://github.com/hakkisagdic/colab-bridge
    colab-bridge start        # then open `colab-bridge link` in Colab (a GPU runtime)

Then, from the repo root (standard library only):

    python3 training/colab.py all       # train, wait for it, fetch the checkpoint
    python3 training/colab.py train     # upload the labels, install Laya, clone this commit, train in the background
    python3 training/colab.py status    # tail of the training log
    python3 training/colab.py fetch     # package the checkpoint in the runtime and copy it to training/checkpoints/
    python3 training/colab.py clean     # stop the run and remove everything this script put in the runtime

The runtime clones this repository at the local HEAD, so push before training. Teacher labels
travel as gzip + base64 in 200 KB pieces through one reused cell, and never leave the runtime.

Each cell runs inside a function and hands directories to its subprocesses, so the kernel's
names and working directory stay as they were and the runtime can be shared with other
notebooks. `train` does pip-install Laya into the runtime's Python. On a runtime shared with other
projects, claim the GPU first (colab-bridge 0.2+) and pass the same --project here:

    colab-bridge --project laya claim --vram 24 --for 30m training
    python3 training/colab.py all --project laya
    colab-bridge --project laya release
"""
import argparse
import base64
import gzip
import hashlib
import os
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REPO_URL = "https://github.com/hakkisagdic/neo-vs-morpheus.git"
REMOTE_HOME = "/content"
REMOTE_REPO = REMOTE_HOME + "/neo-vs-morpheus"
CHUNK = 200_000  # base64 characters per upload cell


def bridge(args, *command):
    base = ["colab-bridge"] + (["--port", str(args.port)] if args.port else []) + (["--dir", args.dir] if args.dir else [])
    return base + (["--project", args.project] if args.project else []) + list(command)


def cell(title, body):
    """Notebook code titled on its first line (colab-bridge reuses the cell with that title); the
    body runs inside a function so it leaves no names behind in the kernel."""
    body = textwrap.indent(textwrap.dedent(body).strip(), "    ")
    return f"# neo-vs-morpheus: {title}\ndef _neo_cell():\n{body}\ntry:\n    _neo_cell()\nfinally:\n    del _neo_cell\n"


def run_cell(args, code):
    """Runs code as a notebook cell and returns its output."""
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(code)
    try:
        out = subprocess.run(bridge(args, "run", f.name), capture_output=True, text=True)
    finally:
        os.unlink(f.name)
    if out.returncode != 0:
        sys.exit(f"colab-bridge run failed: {out.stderr.strip() or out.stdout.strip()}")
    return out.stdout


def git(*a):
    return subprocess.run(["git", "-C", ROOT] + list(a), capture_output=True, text=True).stdout.strip()


def script():
    """finetune.py in the runtime's clone; the absolute path tells our run apart from anyone else's."""
    return REMOTE_REPO + "/training/finetune.py"


def upload(args, payload):
    """Writes the labels into the runtime piece by piece; the notebook keeps only the last piece."""
    for i in range(0, len(payload), CHUNK):
        mode = "w" if i == 0 else "a"
        run_cell(args, cell("upload", f'''
with open("{REMOTE_HOME}/{args.name}.labels.b64", "{mode}") as f:
    f.write("{payload[i:i + CHUNK]}")
'''))


def train(args):
    commit = git("rev-parse", "HEAD")
    if git("branch", "-r", "--contains", commit) == "":
        sys.exit(f"commit {commit[:9]} is not on GitHub yet; push first (the runtime clones it)")
    with open(os.path.join(ROOT, args.data), "rb") as f:
        data = f.read()
    upload(args, base64.b64encode(gzip.compress(data, 9)).decode())
    setup = cell("setup", f'''
import base64, gzip, hashlib, os, subprocess
repo = {REMOTE_REPO!r}
subprocess.run("pip install -q laya==0.3.20", shell=True, check=True)
if not os.path.isdir(repo):
    subprocess.run(["git", "clone", "-q", {REPO_URL!r}, repo], check=True)
subprocess.run("git fetch -q --depth 1 origin {commit} && git checkout -q FETCH_HEAD", shell=True, check=True, cwd=repo)
os.makedirs(repo + "/training/data", exist_ok=True)
with open("{REMOTE_HOME}/{args.name}.labels.b64") as f:
    data = gzip.decompress(base64.b64decode(f.read()))
os.remove("{REMOTE_HOME}/{args.name}.labels.b64")
with open(repo + "/training/data/labeled.jsonl", "wb") as f:
    f.write(data)
ok = hashlib.sha256(data).hexdigest() == "{hashlib.sha256(data).hexdigest()}"
print("commit", subprocess.run(["git", "log", "--oneline", "-1"], capture_output=True, text=True, cwd=repo).stdout.strip())
print("labels", data.count(b"\\n"), "lines, checksum", "ok" if ok else "MISMATCH")
print(subprocess.run("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader", shell=True, capture_output=True, text=True).stdout.strip() or "no GPU")
''')
    print(run_cell(args, setup).strip())
    start = cell("train", f'''
import subprocess
if subprocess.run(["pgrep", "-f", {script()!r}], capture_output=True).returncode == 0:
    raise SystemExit("a training run is already going")
with open("{REMOTE_HOME}/{args.name}.log", "w") as log:
    p = subprocess.Popen(["python", "-u", {script()!r}, "--mode", "top",
                          "--train-top-layers", "{args.train_top_layers}", "--epochs", "{args.epochs}",
                          "--batch", "{args.batch}", "--accum", "1", "--holdout", "{args.holdout}",
                          "--data", "training/data/labeled.jsonl",
                          "--out", "training/checkpoints/{args.name}"],
                         cwd={REMOTE_REPO!r}, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
print("training started, pid", p.pid)
''')
    print(run_cell(args, start).strip())


def status(args, quiet=False):
    code = cell("status", f'''
import os, shutil, subprocess
path = "{REMOTE_HOME}/{args.name}.log"
lines = []
if os.path.exists(path):
    with open(path) as f:
        lines = f.read().splitlines()
keep = [l for l in lines if l.startswith(("device", "trainable", "before", "epoch", "fitted", "saved", "Traceback")) or "Error" in l]
print("\\n".join(keep[-10:]))
pids = subprocess.run(["pgrep", "-f", {script()!r}], capture_output=True, text=True).stdout.split()
print("running", bool(pids))
apps = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader"],
                      capture_output=True, text=True).stdout if pids and shutil.which("nvidia-smi") else ""
for line in apps.splitlines():
    if line.split(",")[0].strip() in pids:
        print("gpu memory", line.split(",")[1].strip())
''')
    out = run_cell(args, code)
    if not quiet:
        print(out.strip())
    return out


def wait(args):
    seen = set()
    while True:
        out = status(args, quiet=True)
        for line in out.splitlines():
            if line not in seen and not line.startswith("running"):
                seen.add(line)
                print(line, flush=True)
        if "running False" in out:
            if "saved " not in out:
                sys.exit("training stopped without saving a checkpoint; see `status`")
            return
        time.sleep(30)


def fetch(args):
    tar_path = f"{REMOTE_HOME}/{args.name}.tar"
    package = cell("package", f'''
import hashlib, os, tarfile
with tarfile.open("{tar_path}", "w") as t:
    t.add("{REMOTE_REPO}/training/checkpoints/{args.name}", arcname="{args.name}")
h = hashlib.sha256()
with open("{tar_path}", "rb") as f:
    for chunk in iter(lambda: f.read(1 << 24), b""):
        h.update(chunk)
print(os.path.getsize("{tar_path}"), h.hexdigest())
''')
    size, digest = run_cell(args, package).split()[-2:]
    print(f"packaged {int(size) / 1e6:.0f} MB, sha256 {digest[:16]}...; copying (4 MB parts)")
    out_dir = os.path.join(ROOT, "training", "checkpoints")
    os.makedirs(out_dir, exist_ok=True)
    local_tar = os.path.join(out_dir, f"{args.name}.tar")
    subprocess.run(bridge(args, "fetch", tar_path, local_tar), check=True)
    h = hashlib.sha256()
    with open(local_tar, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 24), b""):
            h.update(chunk)
    if h.hexdigest() != digest:
        sys.exit(f"checksum mismatch: {h.hexdigest()} != {digest}")
    run_cell(args, cell("unpackage", f'''
import os
os.remove("{tar_path}")
'''))
    with tarfile.open(local_tar) as t:
        t.extractall(out_dir, filter="data")
    if not args.keep_tar:
        os.unlink(local_tar)
    print(f"checkpoint ready: training/checkpoints/{args.name} (serve it with scripts/laya-native.sh start training/checkpoints/{args.name})")


def clean(args):
    code = cell("clean", f'''
import os, shutil, subprocess
subprocess.run(["pkill", "-f", {script()!r}])
shutil.rmtree({REMOTE_REPO!r}, ignore_errors=True)
for path in ("{REMOTE_HOME}/{args.name}.log", "{REMOTE_HOME}/{args.name}.tar", "{REMOTE_HOME}/{args.name}.labels.b64"):
    if os.path.exists(path):
        os.remove(path)
print("removed", {REMOTE_REPO!r}, "and {REMOTE_HOME}/{args.name}.log")
''')
    print(run_cell(args, code).strip())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["train", "status", "wait", "fetch", "all", "clean"])
    ap.add_argument("--port", type=int, help="colab-bridge control port (default: colab-bridge's own)")
    ap.add_argument("--dir", help="colab-bridge state dir, for bridges started with --dir")
    ap.add_argument("--project", help="colab-bridge 0.2+ project: names our cells and holds our GPU claim on a shared runtime")
    ap.add_argument("--name", default="neo-duel", help="checkpoint name")
    ap.add_argument("--data", default="training/data/labeled.jsonl")
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--train-top-layers", type=int, default=28, help="28 = the whole encoder")
    ap.add_argument("--holdout", type=float, default=0.1, help="share of the labels kept for fitting the temperature")
    ap.add_argument("--keep-tar", action="store_true", help="keep the downloaded tarball (e.g. for a release)")
    args = ap.parse_args()
    if args.command in ("train", "all"):
        train(args)
    if args.command == "status":
        status(args)
    if args.command in ("wait", "all"):
        wait(args)
    if args.command in ("fetch", "all"):
        fetch(args)
    if args.command == "clean":
        clean(args)


if __name__ == "__main__":
    main()
