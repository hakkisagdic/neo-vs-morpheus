#!/bin/bash
# world.sh [sosaria] [start|stop|spawn|unspawn <set>|logs N|gm "<command>"...|activity N]: a ModernUO
# server on EA's client files (the real map), apart from the arena lanes, on 127.0.0.1:2650 with its
# own world save. It is the world for watching the bots in ClassicUO/Navrey and for agents that play
# whole sessions; the lanes keep the synthetic arena, so that their numbers stay comparable with
# everything measured before.
#
#   lab/world.sh start           # the client files from $UO_DATA_DIR (default ~/UO/client)
#   lab/world.sh gm "[Decorate"  # GM commands as the owner (npm run nvm -- gm)
#   lab/world.sh spawn           # the spawn sets of lab/world-spawns.json, after [Decorate,
#                                # [SignGen, [TelGen and [MoonGen
#   lab/world.sh unspawn uoml/trammel   # one set's spawners deleted by id, with what they spawned
#
# "sosaria" first picks a second world: SosariaAI's server-side player bots (the image's opt-in
# plugin, see server/entrypoint.sh) on 127.0.0.1:2651, container laya-sosaria, volume
# laya-sosaria-save, which also holds the plugin's files (characters.json, brain.json, memory.db,
# nav graphs, activity.log). Its people live where SOSARIA_MAPS says (default Felucca=0,Trammel=10;
# a facet added later needs its spawners: [ImportSpawners Data/Spawns/<shared|uoml>/<facet>/*.json).
# Laya decides their fight stances: a server of its own on this Mac's GPU on 127.0.0.1:8651
# (SOSARIA_LAYA_PORT) with the trainer's champion (SOSARIA_LAYA_CHECKPOINT overrides), which start
# launches when nothing answers there and stop ends. There is no chat model, so no paid call.
#
#   lab/world.sh sosaria start          # a new volume also gets First Time Setup and a restart
#   lab/world.sh sosaria activity 50    # the plugin's per-character log
#   lab/world.sh sosaria gm "[Sosaria"  # staff commands; [Sosaria lists the people in the log
#   lab/world.sh sosaria stop           # saves, then stops the server and its Laya server
#
# The owner account and the bots' password come from the repo's .env, as for the lanes.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA=${UO_DATA_DIR:-$HOME/UO/client}
IMAGE=${UO_IMAGE:-neo-vs-morpheus/modernuo:225c634}
world=main
if [ "${1:-}" = sosaria ]; then world=sosaria; shift; fi
if [ "$world" = sosaria ]; then port=2651 name=laya-sosaria; else port=2650 name=laya-world; fi
set -a; . "$ROOT/.env"; set +a
# grep reads the whole log: with -q it stops at the first match, and a long log's writer then dies
# of SIGPIPE, which pipefail turns into "no match".
logged() { docker logs "$name" 2>&1 | grep -F -- "$1" >/dev/null; }
listening() { logged "Listening: "; }

maps=${SOSARIA_MAPS:-Felucca=0,Trammel=10}
lport=${SOSARIA_LAYA_PORT:-8651}
pidfile=$ROOT/.fleet/mac/sosaria-laya-$lport.pid
gm() { (cd "$ROOT/bot" && UO_HOST=127.0.0.1 UO_PORT=$port npm run -s nvm -- gm "$@"); }
laya_up() { curl -sf -m 3 "http://127.0.0.1:$lport/health" 2>/dev/null | grep typed-decisions >/dev/null; }

# A Laya server for the fight stances, in a session of its own so that it outlives this script.
sosaria_laya() {
  laya_up && return
  local ckpt=${SOSARIA_LAYA_CHECKPOINT:-} champion log=$ROOT/.fleet/mac/laya-$lport.log
  if [ -z "$ckpt" ]; then
    champion=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["champion"])' "$ROOT/.fleet/trainer.json" 2>/dev/null || true)
    ckpt=$ROOT/training/checkpoints/$champion
  fi
  [ -f "$ckpt/rl_agent_config.json" ] || { echo "no Laya checkpoint in $ckpt; set SOSARIA_LAYA_CHECKPOINT" >&2; exit 1; }
  mkdir -p "$(dirname "$pidfile")"
  python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    "$ROOT/lab/mac/model.sh" "$lport" "$ckpt" >>"$log" 2>&1 </dev/null &
  echo $! >"$pidfile"
  for _ in $(seq 120); do laya_up && break; sleep 2; done
  laya_up || { echo "Laya did not come up on $lport; see $log" >&2; exit 1; }
  echo "Laya on 127.0.0.1:$lport serves $(basename "$ckpt")"
}

# Only the Laya server this script started, by its recorded pid and name.
sosaria_laya_stop() {
  [ -f "$pidfile" ] || return 0
  local pid
  pid=$(cat "$pidfile")
  if ps -p "$pid" -o command= | grep -q "^mac-laya-$lport "; then
    kill "$pid"
    echo "stopped the Laya server on $lport"
  fi
  rm -f "$pidfile"
}

# The server, waited for until it says it listens: the first boot after First Time Setup builds the
# nav graph of each facet with people first, which takes minutes.
sosaria_run() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -p "127.0.0.1:$port:$port" -v laya-sosaria-save:/app/World -v "$DATA:/uodata:ro" \
    -v "$ROOT/templates:/app/NeoTemplates:ro" -e NEO_PORT="$port" -e NEO_PUBLIC_ADDRESS=127.0.0.1 \
    -e NEO_SERVER_NAME="laya sosaria" -e NEO_EXPANSION=7 -e NEO_REAGENTS=200 \
    -e NEO_OWNER_USER="${NEO_OWNER_USER:-architect}" -e NEO_OWNER_PASS \
    -e NEO_SOSARIA=1 -e NEO_SOSARIA_MAPS="$maps" -e NEO_SOSARIA_ACTIVITY_LOG=1 \
    -e NEO_SOSARIA_LAYA_URL="http://host.docker.internal:$lport" "$IMAGE" >/dev/null
  for _ in $(seq 1800); do
    listening && break
    [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || break
    sleep 1
  done
  listening || { echo "the SosariaAI world server did not start:"; docker logs --tail 30 "$name"; exit 1; }
  sleep 3 # the owner account is made right after the server listens
}

# First Time Setup as [SosariaPanel runs it (WorldSetupRules.Steps of the pinned plugin, for the ML
# era band of NEO_EXPANSION=7): the world's items, then the shared and uoml spawners of each facet
# with people, as the owner; then a save. The plugin brings its people in at the next boot.
sosaria_setup() {
  local commands=("[Decorate" "[DoorGen" "[SignGen" "[TelGen" "[MoonGen" "[GenChamps") facet set
  for facet in $(echo "$maps" | tr ',' '\n' | awk -F= '$2 > 0 {print tolower($1)}'); do
    for set in shared uoml; do
      if docker exec "$name" test -d "Data/Spawns/$set/$facet"; then
        commands+=("[ImportSpawners Data/Spawns/$set/$facet/*.json")
      fi
    done
  done
  gm --wait 30 "${commands[@]}" "[Save"
  # The commands run one after another on the server, maybe after the session closed: wait for a
  # save that follows the last import.
  for _ in $(seq 300); do
    docker logs "$name" 2>&1 | awk '/is generating spawners from/ {s = 0} /Saving world done/ {s = 1} END {exit !s}' && return
    sleep 1
  done
  echo "the setup's save did not finish:"; docker logs --tail 30 "$name"; exit 1
}

case "${1:-start}" in
  start)
    [ -f "$DATA/tiledata.mul" ] || { echo "no client files in $DATA"; exit 1; }
    if [ "$world" = sosaria ]; then
      sosaria_laya
      sosaria_run
      if logged "characters spawn after it"; then
        echo "a new world: First Time Setup, then a restart that builds the nav graphs (minutes)"
        sosaria_setup
        sosaria_run
      fi
      echo "SosariaAI world up on 127.0.0.1:$port (people $maps), fight stances by Laya on 127.0.0.1:$lport"
      exit
    fi
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" -p "127.0.0.1:$port:$port" -v laya-world-save:/app/World -v "$DATA:/uodata:ro" \
      -v "$ROOT/templates:/app/NeoTemplates:ro" -e NEO_PORT="$port" -e NEO_PUBLIC_ADDRESS=127.0.0.1 \
      -e NEO_SERVER_NAME="laya world" -e NEO_EXPANSION=7 -e NEO_REAGENTS=200 \
      -e NEO_OWNER_USER="${NEO_OWNER_USER:-architect}" -e NEO_OWNER_PASS "$IMAGE" >/dev/null
    # The port opens before the server listens (Docker's proxy): wait for the server's own word.
    for _ in $(seq 240); do listening && break; sleep 1; done
    listening || { echo "the world server did not start:"; docker logs --tail 30 "$name"; exit 1; }
    echo "world server up on 127.0.0.1:$port, client files from $DATA"
    ;;
  stop)
    if [ "$world" = sosaria ]; then
      if listening; then gm --wait 10 "[Save" || true; fi
      docker stop -t 30 "$name" >/dev/null 2>&1 || true
      docker rm -f "$name" >/dev/null 2>&1 || true
      sosaria_laya_stop
    else
      docker rm -f "$name"
    fi
    ;;
  logs) docker logs --tail "${2:-40}" "$name" ;;
  activity)
    [ "$world" = sosaria ] || { echo "the activity log is SosariaAI's: world.sh sosaria activity [N]" >&2; exit 2; }
    docker exec "$name" tail -n "${2:-40}" World/sosariaai/activity.log
    ;;
  spawn)
    [ "$world" = main ] || { echo "SosariaAI's world gets its spawners from First Time Setup (world.sh sosaria start)" >&2; exit 2; }
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
  *) echo "world.sh [sosaria] [start|stop|spawn|unspawn <set>|logs N|gm \"<command>\"...|activity N]" >&2; exit 2 ;;
esac
