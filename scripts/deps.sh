#!/usr/bin/env bash
# Pinned upstream sources (deps.lock) and their offline backups.
#
#   scripts/deps.sh sync     check every dependency out into vendor/<name> at its pinned
#                            commit; when upstream is unreachable (deleted, taken down,
#                            offline) it restores from backups/<name>.bundle instead
#   scripts/deps.sh backup   refresh backups/<name>.bundle (full history, all branches and
#                            tags) from upstream; the old bundle is replaced only after the
#                            new one verifies and contains the pinned commit
#   scripts/deps.sh status   show checkouts and backups
#
# NVM_BACKUP_DIR overrides the backup directory (default: ./backups).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"
BACKUPS="${NVM_BACKUP_DIR:-$ROOT/backups}"

deps() { grep -vE '^[[:space:]]*(#|$)' "$ROOT/deps.lock"; }

sync_one() {
  local name=$1 commit=$2 url=$3 dir="$VENDOR/$1"

  if [ -d "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$commit" ]; then
    echo "ok        $name @ ${commit:0:9}"
    return
  fi

  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$dir" init -q

  if git -C "$dir" fetch -q --depth 1 "$url" "$commit" 2>/dev/null; then
    git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
    echo "upstream  $name @ ${commit:0:9}"
  elif [ -f "$BACKUPS/$name.bundle" ] \
    && git -C "$dir" fetch -q "$BACKUPS/$name.bundle" '+refs/*:refs/backup/*' 2>/dev/null \
    && git -C "$dir" cat-file -e "$commit^{commit}" 2>/dev/null; then
    git -C "$dir" -c advice.detachedHead=false checkout -q "$commit"
    echo "backup    $name @ ${commit:0:9} (upstream unreachable, restored from $BACKUPS/$name.bundle)"
  else
    echo "FAILED    $name: upstream unreachable and no backup holds ${commit:0:9}" >&2
    return 1
  fi
}

backup_one() {
  local name=$1 commit=$2 url=$3 tmp
  tmp="$(mktemp -d)"

  if ! git clone -q --bare "$url" "$tmp/$name.git"; then
    echo "FAILED    $name: cannot clone $url; keeping the old bundle" >&2
    rm -rf "$tmp"
    return 1
  fi
  if ! git -C "$tmp/$name.git" cat-file -e "$commit^{commit}" 2>/dev/null; then
    echo "FAILED    $name: upstream no longer has pinned commit ${commit:0:9}; keeping the old bundle" >&2
    rm -rf "$tmp"
    return 1
  fi
  git -C "$tmp/$name.git" bundle create -q "$tmp/$name.bundle" --all
  git -C "$tmp/$name.git" bundle verify -q "$tmp/$name.bundle" >/dev/null

  mkdir -p "$BACKUPS"
  mv -f "$tmp/$name.bundle" "$BACKUPS/$name.bundle"
  rm -rf "$tmp"
  printf '%s\t%s\t%s\t%s\n' "$name" "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$url" \
    > "$BACKUPS/$name.manifest"
  echo "backed up $name ($(du -h "$BACKUPS/$name.bundle" | cut -f1)) -> $BACKUPS/$name.bundle"
}

status() {
  deps | while read -r name commit url; do
    local head="-" bundle="-"
    [ -d "$VENDOR/$name/.git" ] && head="$(git -C "$VENDOR/$name" rev-parse --short=9 HEAD)"
    [ -f "$BACKUPS/$name.manifest" ] && bundle="$(cut -f3 "$BACKUPS/$name.manifest")"
    printf '%-10s pinned %s  vendor %s  backup %s\n' "$name" "${commit:0:9}" "$head" "$bundle"
  done
}

case "${1:-}" in
  sync)   deps | while read -r name commit url; do sync_one "$name" "$commit" "$url"; done ;;
  backup) deps | while read -r name commit url; do backup_one "$name" "$commit" "$url"; done ;;
  status) status ;;
  *) echo "usage: $0 sync|backup|status" >&2; exit 2 ;;
esac
