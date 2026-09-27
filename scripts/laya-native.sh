#!/usr/bin/env bash
# Laya served natively on Apple silicon (Metal/MPS), much faster than the CPU-only Docker image.
# Everything lives in .laya/ (git-ignored): the Python env, the Hugging Face cache and the log.
#
#   scripts/laya-native.sh start [model]   serve on 127.0.0.1:${LAYA_NATIVE_PORT:-8001} (default model: typed-decisions)
#   scripts/laya-native.sh stop
#   scripts/laya-native.sh status
#   scripts/laya-native.sh clean           stop and delete .laya/ entirely
#
# Point the bot at it with LAYA_URL=http://127.0.0.1:8001 in .env.
# A fine-tuned checkpoint directory can be served with: start /path/to/checkpoint
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$ROOT/.laya"
VENV="$HOME_DIR/venv"
PORT="${LAYA_NATIVE_PORT:-8001}"
PIDFILE="$HOME_DIR/serve.pid"
LOG="$HOME_DIR/serve.log"
LAYA_VERSION="0.3.20"

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

ensure_env() {
  if [ ! -x "$VENV/bin/laya-serve" ]; then
    command -v uv >/dev/null || { echo "uv is required: https://docs.astral.sh/uv/" >&2; exit 1; }
    mkdir -p "$HOME_DIR"
    uv venv -q --python 3.12 "$VENV"
    VIRTUAL_ENV="$VENV" uv pip install -q "laya[serve]==$LAYA_VERSION"
  fi
}

case "${1:-}" in
  start)
    if running; then
      echo "already running (pid $(cat "$PIDFILE")) on :$PORT"
      exit 0
    fi
    ensure_env
    model="${2:-typed-decisions}"
    if [ -d "$model" ]; then
      # a local checkpoint (training/finetune.py output) served under the typed-decisions name
      cmd=("$VENV/bin/python" "$ROOT/training/serve_checkpoint.py" "$model")
      model=typed-decisions
    else
      cmd=("$VENV/bin/laya-serve")
    fi
    env HF_HOME="$HOME_DIR/hf" LAYA_DEVICE=mps LAYA_PRELOAD=1 LAYA_HOST=127.0.0.1 LAYA_PORT="$PORT" \
      LAYA_MODELS="$model" PYTORCH_ENABLE_MPS_FALLBACK=1 TOKENIZERS_PARALLELISM=false \
      nohup "${cmd[@]}" >"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    printf 'starting laya-serve (pid %s) on :%s' "$(cat "$PIDFILE")" "$PORT"
    for _ in $(seq 1 240); do
      if curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
        echo " ready"
        curl -s "http://127.0.0.1:$PORT/health"; echo
        exit 0
      fi
      running || { echo " failed; see $LOG" >&2; tail -20 "$LOG" >&2; exit 1; }
      printf '.'
      sleep 2
    done
    echo " still loading; see $LOG"
    ;;
  stop)
    if running; then
      kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE" && echo "stopped"
    else
      rm -f "$PIDFILE"
      echo "not running"
    fi
    ;;
  status)
    if running; then
      echo "running (pid $(cat "$PIDFILE")) on :$PORT"
      curl -s "http://127.0.0.1:$PORT/health" || true
      echo
    else
      echo "not running"
    fi
    du -sh "$HOME_DIR" 2>/dev/null || true
    ;;
  clean)
    "$0" stop
    rm -rf "$HOME_DIR"
    echo "removed $HOME_DIR"
    ;;
  *)
    echo "usage: $0 start [model|checkpoint-dir] | stop | status | clean" >&2
    exit 2
    ;;
esac
