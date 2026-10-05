#!/bin/bash
# lane.sh <i> <series.json> [series options]: a lane on this Mac. Arena server i runs in Docker
# (neo-vs-morpheus/modernuo, listening on 127.0.0.1:2593+i, a port of its own because the server
# sends clients to its own port for the game connection); the series runs here, natively, against
# the Laya server on 127.0.0.1:8001+i (lab/mac/model.sh; LAYA_PORT picks another, so that lanes can
# share one: Metal serves one process at a time). Passwords come from the repo's .env.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd); i=$1; series=$2; shift 2
port=$((2593 + i)); name=laya-mac-uo-$i
set -a; . "$ROOT/.env"; set +a
up() { (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; }
if ! up; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -p "127.0.0.1:$port:$port" -v "$name-world:/app/World" -v "$ROOT/templates:/app/NeoTemplates:ro" \
    -e NEO_PORT="$port" -e NEO_PUBLIC_ADDRESS=127.0.0.1 -e NEO_SERVER_NAME="mac lab $i" -e NEO_EXPANSION=7 -e NEO_REAGENTS=200 \
    -e NEO_OWNER_USER="${NEO_OWNER_USER:-architect}" -e NEO_OWNER_PASS neo-vs-morpheus/modernuo:225c634 >/dev/null
  for _ in $(seq 120); do up && break; sleep 1; done
  up || { echo "arena server $i did not open port $port"; exit 1; }
  sleep 3  # the owner account is made right after the port opens
  echo "arena server $i up on $port"
fi
cd "$ROOT/bot"
export UO_HOST=127.0.0.1 UO_PORT=$port LAYA_URL=http://127.0.0.1:${LAYA_PORT:-$((8001 + i))} RULES_REACTION_MS=${RULES_REACTION_MS:-100} \
  MONITOR_PORT=$((9000 + 100 * i)) FLEET_INSTANCE=mac FLEET_LANE=$i
exec -a "mac-series-$i" node src/cli.ts series "$series" "$@"
