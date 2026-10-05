#!/bin/bash
# notebook-lanes.sh HOURS MODEL...: lanes on a GPU notebook node with no root and no Docker (Camber's
# GPU Xsmall), once setup.sh has installed the arena in $ARENA_DIR (default /home/jovyan/arena): a
# Laya server per model on the node's GPU (8001, 8002, …; checkpoints in $ARENA_DIR/models/<model>)
# and a lane per server playing $SERIES (default lab/series-explore12.json), until HOURS are up. The
# node bills until it is stopped in the web app, so stop it when the lanes end.
#   bash /home/jovyan/arena/nvm/lab/vm/notebook-lanes.sh 3.2 neo-duel-v8 neo-duel-v8-dagger-all
set -euo pipefail
A=${ARENA_DIR:-/home/jovyan/arena}; hours=$1; shift
export ARENA_DIR=$A
cd "$A"
# A node can come up without its GPU, and Laya on the CPU times out on every decision.
ls /dev/nvidia* >/dev/null 2>&1 || { echo "no GPU on this node (no /dev/nvidia*): stop it and start it again"; exit 1; }
# The image pairs torch 2.8 with torchaudio 2.11, which transformers imports and crashes on.
python3 -m pip uninstall -y -q torchaudio 2>/dev/null || true
# Installed once, here: two servers installing at the same time break each other's install.
python3 -c 'import laya.serve' 2>/dev/null || python3 -m pip install -q 'laya[serve]==0.3.20'
ports=()
for model in "$@"; do
  port=$((8001 + ${#ports[@]})); ports+=("$port")
  pgrep -f "[l]aya-serve-$port" >/dev/null || setsid nohup bash nvm/lab/vm/model.sh "$port" "$A/models/$model" > "laya-$port.log" 2>&1 < /dev/null &
done
# A lane whose Laya is down plays nothing but lost rounds: start none unless every server answers.
up() { [[ $(curl -s -m 3 "127.0.0.1:$1/health") == *typed* ]]; }
for port in "${ports[@]}"; do
  for _ in $(seq 150); do up "$port" && break; sleep 2; done
  up "$port" || { echo "Laya on $port did not start:"; tail -5 "laya-$port.log"; exit 1; }
done
series=$A/nvm/${SERIES:-lab/series-explore12.json}
end=$(( $(date +%s) + $(awk -v h="$hours" 'BEGIN { printf "%d", h * 3600 }') ))
for lane in "${!ports[@]}"; do
  echo "### $(date -u +%FT%TZ) $(basename "$series")" >> "lane-$lane.series.log"
  FLEET_INSTANCE=${FLEET_INSTANCE:-camber} setsid nohup bash -c \
    "while [ \$(date +%s) -lt $end ]; do bash nvm/lab/vm/lane.sh $lane $series --parallel ${PARALLEL:-6}; done" \
    >> "lane-$lane.series.log" 2>&1 < /dev/null &
done
# A series under way at the end would play on past it: the end stops it too.
setsid nohup bash -c "sleep $(( end - $(date +%s) )); pkill -f '[a]rena-series-'" > /dev/null 2>&1 < /dev/null &
echo "${#ports[@]} lanes until $(date -u -d "@$end" +%H:%MZ); stop the node then"
