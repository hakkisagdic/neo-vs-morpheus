#!/bin/bash
# clef.sh [model=clef] [port=8300]: Cloudflare's Clef (or clef-flash) on this VM's GPU through the
# System One API (lab/clef/serve.py), for lanes whose fighters are "clef". Its own Python env
# (/content/clef-venv: the weights need a newer transformers than laya-serve), the weights from
# Hugging Face (public, ~54 GB for clef) on first use; nothing to do when it already answers.
set -euo pipefail
A=${ARENA_DIR:-/content/arena}; model=${1:-clef}; port=${2:-8300}
V=/content/clef-venv; D=/content/$model
# Any answer, even "bad request", means the server is up.
if curl -s -o /dev/null -m 3 -X POST "http://127.0.0.1:$port/v1/systemone" -d '{}'; then
  echo "clef already serving on $port"; exit 0
fi
command -v uv >/dev/null || python3 -m pip install -q uv
[ -x "$V/bin/python" ] || uv venv -q "$V" --python 3.12
"$V/bin/python" -c 'import torch, torchvision, transformers, accelerate, PIL' 2>/dev/null ||
  uv pip install -q --python "$V/bin/python" torch torchvision 'transformers>=5.10' accelerate pillow safetensors huggingface_hub
[ -f "$D/joint_head.safetensors" ] || "$V/bin/hf" download "Cloudflare/$model" --local-dir "$D" >/dev/null
# No `exec -a`: a renamed argv[0] hides the virtual env from Python.
exec "$V/bin/python" -u "$A/nvm/lab/clef/serve.py" "$D" --port "$port" --device cuda --dtype bfloat16
