#!/usr/bin/env bash
# A local SphereServer-X shard in Docker, next to the ModernUO lanes (which use 2593+i).
#
#   server/sphere/sphere.sh build         build laya-sphere:<source-x>-<scripts-x> from vendor/emulators
#   server/sphere/sphere.sh start         build if needed, start container laya-sphere on 127.0.0.1:2700
#   server/sphere/sphere.sh stop          save the world and remove the container (the data volume stays)
#   server/sphere/sphere.sh status|logs   container state / server console output
#   server/sphere/sphere.sh console '#'   a line on Sphere's console ("#" saves, "?" lists commands)
#   server/sphere/sphere.sh bot <cmd...>  the bot CLI against this shard, e.g. `bot login Neo`
#
# Settings come from the environment, then from the repo's .env (the environment wins):
#   SPHERE_PORT (2700)        listen port; also the port Sphere hands clients for the game
#                             connection, so host and container use the same number
#   SPHERE_CONTAINER (laya-sphere)  container name; its data volume is <name>-data
#   SPHERE_SOURCE_DIR, SPHERE_SCRIPTS_DIR (vendor/emulators/source-x, vendor/emulators/scripts-x)
#   UO_DATA_DIR (server/client-files)  real client files, mounted read-only; empty = synthetic world
#   SPHERE_OWNER_PASS, SPHERE_BOT_PASSWORD  passwords for this shard, used instead of
#                             NEO_OWNER_PASS / BOT_PASSWORD: Sphere keeps at most 16 characters
#   SPHERE_JOBS (6), SPHERE_CPUS (2), SPHERE_MEMORY (2g)  build parallelism, container limits
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)

# The repo's .env, without overriding what the environment already sets.
if [ -f "$ROOT/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '#'*) continue ;; [!=]*=*) ;; *) continue ;; esac
    key=${line%%=*}
    case "$key" in [0-9]* | *[!A-Za-z0-9_]*) continue ;; esac
    [ -n "${!key+set}" ] && continue
    value=${line#*=}
    case "$value" in \"*\" | \'*\') value=${value:1:${#value}-2} ;; esac
    export "$key=$value"
  done < "$ROOT/.env"
fi

port=${SPHERE_PORT:-2700}
container=${SPHERE_CONTAINER:-laya-sphere}
src=${SPHERE_SOURCE_DIR:-$ROOT/vendor/emulators/source-x}
scripts=${SPHERE_SCRIPTS_DIR:-$ROOT/vendor/emulators/scripts-x}
uodata=${UO_DATA_DIR:-$ROOT/server/client-files}
case "$uodata" in /*) ;; *) uodata=$ROOT/$uodata ;; esac
export NEO_OWNER_USER=${NEO_OWNER_USER:-architect}
export NEO_OWNER_PASS=${SPHERE_OWNER_PASS:-${NEO_OWNER_PASS:-}}

die() {
  echo "sphere: $*" >&2
  exit 1
}

commit() { git -C "$1" rev-parse --short=7 HEAD 2>/dev/null || echo local; }
image() { echo "laya-sphere:$(commit "$src")-$(commit "$scripts")"; }

build() {
  [ -f "$src/CMakeLists.txt" ] || die "no Source-X checkout in $src"
  [ -f "$scripts/spheretables.scp" ] || die "no Scripts-X checkout in $scripts"
  local tag
  tag=$(image)
  docker build -t "$tag" \
    --build-context source-x="$src" --build-context scripts-x="$scripts" \
    --build-arg JOBS="${SPHERE_JOBS:-6}" \
    --label org.opencontainers.image.source=https://github.com/Sphereserver/Source-X \
    --label laya.source-x="$(git -C "$src" rev-parse HEAD 2>/dev/null || echo local)" \
    --label laya.scripts-x="$(git -C "$scripts" rev-parse HEAD 2>/dev/null || echo local)" \
    "$HERE"
  echo "built $tag"
}

running() { [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" = true ]; }

start() {
  local tag
  tag=$(image)
  if running; then
    echo "$container is already running on 127.0.0.1:$(docker port "$container" | sed -n 's/.*://p' | head -1)"
    return
  fi
  docker image inspect "$tag" >/dev/null 2>&1 || build
  [ -n "$NEO_OWNER_PASS" ] || echo "sphere: no SPHERE_OWNER_PASS or NEO_OWNER_PASS; starting without an owner account" >&2
  [ "${#NEO_OWNER_PASS}" -le 16 ] || die "the owner password has ${#NEO_OWNER_PASS} characters; Sphere keeps 16. Set SPHERE_OWNER_PASS (at most 16) in .env"
  mkdir -p "$uodata"
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker run -d --name "$container" --init \
    -p "127.0.0.1:$port:$port" \
    -e SPHERE_PORT="$port" -e SPHERE_SERVER_NAME="${SPHERE_SERVER_NAME:-Laya Sphere}" \
    -e NEO_OWNER_USER -e NEO_OWNER_PASS \
    -v "$container-data:/sphere/data" \
    -v "$uodata:/uodata:ro" \
    --cpus "${SPHERE_CPUS:-2}" --memory "${SPHERE_MEMORY:-2g}" \
    "$tag" >/dev/null
  for _ in $(seq 180); do
    # grep -c reads to the end: grep -q could leave docker logs to die of SIGPIPE under pipefail
    if [ "$(docker logs "$container" 2>&1 | grep -c 'Startup complete')" -gt 0 ]; then
      echo "$container ($tag) up on 127.0.0.1:$port"
      return
    fi
    running || { docker logs --tail 40 "$container" 2>&1; die "$container exited during startup"; }
    sleep 1
  done
  docker logs --tail 40 "$container" 2>&1
  die "$container did not finish starting in 180 s"
}

# A line on Sphere's console (see entrypoint.sh): "#" saves, "X#" saves and exits, "?" lists.
console() {
  running || die "$container is not running"
  docker exec "$container" /bin/bash -c 'printf "%s\n" "$1" > /sphere/console' console "$1"
}

stop() {
  if ! docker inspect "$container" >/dev/null 2>&1; then
    echo "$container is not running"
    return
  fi
  if running; then
    console 'X#'
    for _ in $(seq 60); do
      running || break
      sleep 1
    done
    # Still up: the image's stop signal, SIGHUP, also makes Sphere save before it exits.
    running && docker stop -t 30 "$container" >/dev/null
  fi
  # Sphere's shutdown ends in an abort ("Immediate abort requested") after the save; the save
  # lines are what matters.
  local saved
  saved=$(docker logs --tail 12 "$container" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'save completed|Statics data saved' || true)
  docker rm "$container" >/dev/null
  if [ -n "$saved" ]; then
    printf '%s\n' "$saved"
    echo "$container stopped (world and accounts kept in volume $container-data)"
  else
    echo "$container stopped, but its last log lines show no world save" >&2
  fi
}

case "${1:-}" in
  build) build ;;
  start) start ;;
  stop) stop ;;
  status)
    docker ps -a --filter "name=^$container\$" --format '{{.Names}}  {{.Image}}  {{.Status}}  {{.Ports}}'
    ;;
  logs) shift; docker logs "$@" "$container" ;;
  console) shift; [ $# -gt 0 ] || die "usage: $0 console '<command>'"; console "$*" ;;
  bot)
    shift
    export BOT_PASSWORD=${SPHERE_BOT_PASSWORD:-${BOT_PASSWORD:-}}
    [ "${#BOT_PASSWORD}" -le 16 ] || die "the bot password has ${#BOT_PASSWORD} characters; Sphere keeps 16. Set SPHERE_BOT_PASSWORD (at most 16) in .env"
    export UO_HOST=127.0.0.1 UO_PORT=$port
    cd "$ROOT/bot"
    exec node --env-file-if-exists=../.env src/cli.ts "$@"
    ;;
  *) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 2 ;;
esac
