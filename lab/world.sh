#!/bin/bash
# world.sh [start|stop|spawn|unspawn <set>|logs N|gm "<command>"...]: a ModernUO server on EA's
# client files (the real map), apart from the arena lanes, on 127.0.0.1:2650 with its own world
# save. It is the world for watching the bots in ClassicUO/Navrey and for agents that play whole
# sessions; the lanes keep the synthetic arena, so that their numbers stay comparable with
# everything measured before.
#
#   lab/world.sh start           # the client files from $UO_DATA_DIR (default ~/UO/client)
#   lab/world.sh gm "[Decorate"  # GM commands as the owner (npm run nvm -- gm)
#   lab/world.sh spawn           # the spawn sets of lab/world-spawns.json, after [Decorate,
#                                # [SignGen, [TelGen and [MoonGen
#   lab/world.sh unspawn uoml/trammel   # one set's spawners deleted by id, with what they spawned
#
# The owner account and the bots' password come from the repo's .env, as for the lanes.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA=${UO_DATA_DIR:-$HOME/UO/client}
port=2650
name=laya-world
set -a; . "$ROOT/.env"; set +a
listening() { docker logs "$name" 2>&1 | grep -q "Listening: "; }
case "${1:-start}" in
  start)
    [ -f "$DATA/tiledata.mul" ] || { echo "no client files in $DATA"; exit 1; }
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" -p "127.0.0.1:$port:$port" -v laya-world-save:/app/World -v "$DATA:/uodata:ro" \
      -v "$ROOT/templates:/app/NeoTemplates:ro" -e NEO_PORT="$port" -e NEO_PUBLIC_ADDRESS=127.0.0.1 \
      -e NEO_SERVER_NAME="laya world" -e NEO_EXPANSION=7 -e NEO_REAGENTS=200 \
      -e NEO_OWNER_USER="${NEO_OWNER_USER:-architect}" -e NEO_OWNER_PASS neo-vs-morpheus/modernuo:225c634 >/dev/null
    # The port opens before the server listens (Docker's proxy): wait for the server's own word.
    for _ in $(seq 240); do listening && break; sleep 1; done
    listening || { echo "the world server did not start:"; docker logs --tail 30 "$name"; exit 1; }
    echo "world server up on 127.0.0.1:$port, client files from $DATA"
    ;;
  stop) docker rm -f "$name" ;;
  logs) docker logs --tail "${2:-40}" "$name" ;;
  spawn)
    commands=()
    for set in $(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["sets"]))' "$ROOT/lab/world-spawns.json"); do
      commands+=("[GenerateSpawners Data/Spawns/$set/**/*.json")
    done
    cd "$ROOT/bot" && UO_HOST=127.0.0.1 UO_PORT=$port exec npm run -s nvm -- gm --wait 180 "${commands[@]}" "[Save"
    ;;
  unspawn)
    [ -n "${2:-}" ] || { echo "world.sh unspawn <set>, e.g. uoml/trammel" >&2; exit 2; }
    tmp=$(mktemp -d)
    docker cp "$name:/app/Data/Spawns/$2" "$tmp/set" >/dev/null
    commands=()
    while IFS= read -r line; do commands+=("$line"); done < <(python3 -c 'import glob,json,sys
for f in sorted(glob.glob(sys.argv[1] + "/**/*.json", recursive=True)):
    for s in json.load(open(f)): print("[Global Delete where Spawner Guid = " + s["guid"])' "$tmp/set")
    rm -rf "$tmp"
    cd "$ROOT/bot" && UO_HOST=127.0.0.1 UO_PORT=$port exec npm run -s nvm -- gm --wait 5 "${commands[@]}" "[Save"
    ;;
  gm)
    shift
    cd "$ROOT/bot" && UO_HOST=127.0.0.1 UO_PORT=$port exec npm run -s nvm -- gm "$@"
    ;;
  *) echo "world.sh [start|stop|spawn|unspawn <set>|logs N|gm \"<command>\"...]" >&2; exit 2 ;;
esac
