#!/usr/bin/env bash
# The world and arena server's image on GHCR (.github/workflows/server-image.yml builds it):
#
#   scripts/server-image.sh tag    the tag for this checkout: <modernuo commit>-<overlay content>
#   scripts/server-image.sh pull [name]   pull it and name it neo-vs-morpheus/modernuo:225c634, the name
#                                  the Mac's lanes and lab/world.sh run (alastyr's lab/compose.yml runs
#                                  laya-modernuo:225c634), instead of building it for half an hour
#
# The overlay part hashes what goes into the image from this repo (server/Dockerfile,
# server/entrypoint.sh, server/overlay) and the SosariaAI plugin's pin in deps.lock, so a changed
# overlay or plugin gets a new tag.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE=ghcr.io/hakkisagdic/laya-modernuo
LOCAL=${2:-neo-vs-morpheus/modernuo:225c634}

tag() {
  local modernuo overlay
  modernuo=$(awk '$1 == "modernuo" {print substr($2, 1, 7)}' "$ROOT/deps.lock")
  overlay=$({
    git -C "$ROOT" ls-files -s server/Dockerfile server/entrypoint.sh server/overlay
    awk '$1 == "sosariaai"' "$ROOT/deps.lock"
  } | git hash-object --stdin | cut -c1-8)
  echo "$modernuo-$overlay"
}

case "${1:-tag}" in
  tag) tag ;;
  pull)
    t=$(tag)
    docker pull -q "$IMAGE:$t" >/dev/null
    docker tag "$IMAGE:$t" "$LOCAL"
    echo "$IMAGE:$t pulled as $LOCAL"
    ;;
  *) echo "server-image.sh [tag|pull]" >&2; exit 2 ;;
esac
