#!/bin/bash
# model.sh <port> <checkpoint-dir>: a Laya server on this Mac's GPU (Metal), on 127.0.0.1:<port>;
# lane i uses 8001+i. The Python env is the one scripts/laya-native.sh keeps in .laya/venv.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd); port=$1; ckpt=$2
export LAYA_HOST=127.0.0.1 LAYA_PORT=$port LAYA_MODELS=typed-decisions LAYA_DEVICE=mps PYTORCH_ENABLE_MPS_FALLBACK=1
exec -a "mac-laya-$port" "$ROOT/.laya/venv/bin/python" "$ROOT/training/serve_checkpoint.py" "$ckpt"
