#!/bin/bash
# model.sh <port> <checkpoint-dir>: a Laya server on 127.0.0.1:<port> (lane i uses 8001+i) for a
# checkpoint already on disk; fetching it is the provider's part (its Hugging Face secret).
set -euo pipefail
A=${ARENA_DIR:-/content/arena}; port=$1; ckpt=$2
python3 -c 'import laya.serve' 2>/dev/null || python3 -m pip install -q "laya[serve]==0.3.20"
set -a; . "$A/secrets.env"; set +a
export LAYA_HOST=127.0.0.1 LAYA_PORT=$port LAYA_MODELS=typed-decisions
exec -a "laya-serve-$port" python3 "$A/nvm/training/serve_checkpoint.py" "$ckpt"
