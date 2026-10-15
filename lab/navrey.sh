#!/bin/bash
# navrey.sh [setup|start|stop|restart|status]: Navrey (github.com/johnpwrs/navrey, BSD-2), the
# ClassicUO fork an agent drives through /tmp/cuocmd and /tmp/cuostate.json, from our fork's laya
# branch (github.com/hakkisagdic/navrey: cuoapi loads on Apple Silicon), set up as this project's
# window onto the world server (lab/world.sh, 127.0.0.1:2650):
#
#   lab/navrey.sh setup     # clone at the pinned commit, patch, configure, build (again and again)
#   lab/navrey.sh start     # the client with its window, logged in as $NAVREY_USER (default gemma)
#   lab/navrey.sh restart   # after lab/poi.py: Navrey reads its places only when it starts
#
# What setup changes in the checkout, as this machine's own configuration, not committed:
# - settings.json points at our server, EA's client files (~/UO/client) and lab/poi.py's places
#   (~/UO/poi), without the Razor plugin;
# - .env holds the account, with the bots' password from this repository's .env.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NAVREY=${NAVREY_DIR:-$HOME/Projects/navrey}
FORK=https://github.com/hakkisagdic/navrey.git
COMMIT=2538b41  # the laya branch: cuoapi on arm64, the record command
export DOTNET_ROOT=${DOTNET_ROOT:-$HOME/.dotnet}
DOTNET=$DOTNET_ROOT/dotnet
running() { pgrep -f "^./bin/Debug/net10.0/cuo -agent" || true; }
case "${1:-status}" in
  setup)
    [ -d "$NAVREY/.git" ] || git clone -q -b laya "$FORK" "$NAVREY"
    cd "$NAVREY"
    git remote get-url fork >/dev/null 2>&1 || git remote add fork "$FORK"
    if [ "$(git rev-parse --short=7 HEAD)" != "$COMMIT" ]; then git fetch -q fork && git checkout -q -B laya "$COMMIT"; fi
    BOT_PASSWORD=$(grep '^BOT_PASSWORD=' "$ROOT/.env" | cut -d= -f2- | tr -d '"') \
    NAVREY_USER=${NAVREY_USER:-gemma} python3 - <<'PY'
import json, os
s = json.load(open("settings.json"))
s.update({"ip": "127.0.0.1", "port": 2650, "uo_directory": os.path.expanduser("~/UO/client"), "client_version": "7.0.117.1",
          "poi_directory": os.path.expanduser("~/UO/poi"), "last_server_name": "laya world", "plugins": [],
          # A window taller than the screen leaves room for (1117 points on this MacBook, less the menu bar)
          # is shrunk by macOS while the client keeps drawing at the size asked for: the picture is squeezed
          # and the mouse lands lower than it looks (27 px at the status button with 1061).
          "window_size": {"X": 1150, "Y": 960}, "window_position": {"X": 0, "Y": 40}, "is_win_maximized": False})
json.dump(s, open("settings.json", "w"), indent=2)
with open(".env", "w") as f:
    f.write(f"UO_USER={os.environ['NAVREY_USER']}\nUO_PASS={os.environ['BOT_PASSWORD']}\n")
os.chmod(".env", 0o600)
PY
    "$DOTNET" build -v q -nologo src/ClassicUO.Client/ClassicUO.Client.csproj | tail -2
    "$DOTNET" build -v q -nologo cli/Navrey.Cli.csproj | tail -2
    echo "navrey set up in $NAVREY at $COMMIT"
    ;;
  start)
    [ -z "$(running)" ] || { echo "navrey already running (pid $(running))"; exit 0; }
    cd "$NAVREY"
    rm -f /tmp/cuolog
    # Detached on purpose: the window outlives the shell that started it.
    nohup ./bin/Debug/net10.0/cuo -agent > /tmp/cuostdout.log 2>&1 &
    for _ in $(seq 60); do sleep 2; grep -q "Entered the world" /tmp/cuolog 2>/dev/null && break; done
    grep -q "Entered the world" /tmp/cuolog 2>/dev/null || { echo "navrey did not reach the world:"; tail -5 /tmp/cuostdout.log; exit 1; }
    echo "navrey in the world (pid $(running))"
    ;;
  stop)
    pid=$(running)
    [ -n "$pid" ] || { echo "navrey is not running"; exit 0; }
    kill "$pid"
    for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    echo "navrey stopped"
    ;;
  restart) "$0" stop && "$0" start ;;
  status)
    pid=$(running)
    [ -n "$pid" ] && echo "running (pid $pid)" || echo "not running"
    python3 -c 'import json, time
s = json.load(open("/tmp/cuostate.json"))
print("%s at (%s, %s) on map %s, hits %s/%s%s, state %.0f s old" % (s.get("charName"), s.get("charPosX"), s.get("charPosY"), s.get("map"),
      s.get("hits"), s.get("maxHits"), ", a ghost" if s.get("charGhost") else "", time.time() - s.get("updatedAtMs", 0) / 1000))' 2>/dev/null || true
    ;;
  *) echo "navrey.sh [setup|start|stop|restart|status]" >&2; exit 2 ;;
esac
