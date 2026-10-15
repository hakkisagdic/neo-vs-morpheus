#!/usr/bin/env bash
# The world and arena server's image on GHCR (.github/workflows/server-image.yml builds it):
#
#   scripts/server-image.sh tag    the tag for this checkout: <modernuo commit>-<overlay content>
#   scripts/server-image.sh pull   pull it and name it neo-vs-morpheus/modernuo:225c634 (the name the
#                                  lanes and lab/world.sh run), instead of building it for half an hour
#
# The overlay part hashes what goes into the image from this repo (server/Dockerfile,
# server/entrypoint.sh, server/overlay), so a changed overlay gets a new tag.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE=ghcr.io/hakkisagdic/laya-modernuo
LOCAL=neo-vs-morpheus/modernuo:225c634

tag() {
  local modernuo overlay
  modernuo=$(awk '$1 == "modernuo" {print substr($2, 1, 7)}' "$ROOT/deps.lock")
  overlay=$(git -C "$ROOT" ls-files -s server/Dockerfile server/entrypoint.sh server/overlay | git hash-object --stdin | cut -c1-8)
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
