#!/bin/bash
# The arena lab on a Linux GPU VM (Colab, Kaggle, any GPU box): everything a duel needs on that
# machine and nothing published, because a model behind a tunnel answers in ~250-400 ms where the
# same GPU next to the arena answers in ~40 ms. .NET 10 and ModernUO with our overlay, Node 24 and
# the bot, the synthetic arena data, passwords. Each step leaves a marker, so a rerun picks up where
# it stopped. A working-tree.patch next to it is applied to the checkout (to run uncommitted code).
#
#   curl -fsSLO https://raw.githubusercontent.com/hakkisagdic/neo-vs-morpheus/main/lab/vm/setup.sh
#   ARENA_DIR=/content/arena COMMIT=main bash setup.sh
#
# Then per lane i: model.sh 800<i+1> <checkpoint> (Laya on 127.0.0.1:8001+i) and lane.sh i <series>.
set -euo pipefail
A=${ARENA_DIR:-/content/arena}
COMMIT=${COMMIT:-main}
mkdir -p "$A" && cd "$A"
SUDO=$([ "$(id -u)" = 0 ] || echo sudo)
step() { echo "== $(date +%T) $*"; }
export DOTNET_ROOT=$A/dotnet PATH=$A/dotnet:$A/node/bin:$PATH DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1

if [ ! -f .done-apt ]; then
  step "apt: jq libdeflate0 libargon2-1"
  $SUDO apt-get -qq update >/dev/null && $SUDO apt-get -qq install -y jq libdeflate0 libargon2-1 >/dev/null
  touch .done-apt
fi

if [ ! -f .done-dotnet ]; then
  step ".NET 10 SDK"
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
  bash dotnet-install.sh --channel 10.0 --install-dir "$A/dotnet" >/dev/null
  echo "dotnet $(dotnet --version)"
  touch .done-dotnet
fi

if [ ! -f .done-node ]; then
  step "Node 24"
  line=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep ' node-v24.*-linux-x64.tar.xz$')
  name=${line##* }
  curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$name"
  echo "$line" | sha256sum -c - >/dev/null
  rm -rf node && mkdir node && tar -xJf "$name" -C node --strip-components=1 && rm "$name"
  echo "node $(node --version)"
  touch .done-node
fi

if [ ! -f .done-repo ]; then
  step "repo at $COMMIT with the working-tree patch"
  rm -rf nvm
  git clone -q https://github.com/hakkisagdic/neo-vs-morpheus nvm
  git -C nvm checkout -q "$COMMIT"
  if [ -f "$A/working-tree.patch" ]; then git -C nvm apply "$A/working-tree.patch"; fi
  touch .done-repo
fi

if [ ! -f .done-modernuo ]; then
  step "ModernUO 225c634 with the NeoArena overlay"
  rm -rf modernuo && mkdir modernuo && cd modernuo
  git init -q && git remote add origin https://github.com/modernuo/ModernUO.git
  git fetch -q --depth 1 origin 225c634bf798e545972c16e3465d7896412eefcd && git checkout -q FETCH_HEAD
  cp -r "$A/nvm/server/overlay" Projects/UOContent/NeoArena
  props="-p:NBGV_GitEngine=Disabled -p:RuntimeIdentifiers=linux-x64"
  dotnet restore Projects/Application/Application.csproj -r linux-x64 $props -v q
  dotnet publish Projects/Application/Application.csproj -c Release -r linux-x64 $props --no-restore --self-contained=false -nologo -v q
  find Distribution -name '*.pdb' -delete
  cd "$A" && touch .done-modernuo
fi

if [ ! -f .done-data ]; then
  step "synthetic arena data (as server/Dockerfile makes it)"
  D=$A/arena-data && mkdir -p "$D"
  head -c 3188736 /dev/zero > "$D/tiledata.mul"
  off=$((493568 + (0x80 / 32 + 1) * 4 + 0x80 * 41))
  printf '\120\040\000\000\000\000\000\000' | dd of="$D/tiledata.mul" bs=1 seek=$off conv=notrunc status=none
  printf '\024stone wall' | dd of="$D/tiledata.mul" bs=1 seek=$((off + 20)) conv=notrunc status=none
  for spec in 13ff:1 f5e:1 f61:1 1401:1 1405:1 143e:2 13b2:2 f50:2 1b76:2 13cc:13 13cb:4 13cd:19 13c6:7 13c7:10 1db9:6; do
    id=$((0x${spec%%:*})); off=$((493568 + (id / 32 + 1) * 4 + id * 41))
    printf '\000\000\100\000\000\000\000\000' | dd of="$D/tiledata.mul" bs=1 seek=$off conv=notrunc status=none
    printf "$(printf '\\%03o' ${spec##*:})" | dd of="$D/tiledata.mul" bs=1 seek=$((off + 9)) conv=notrunc status=none
  done
  : > "$D/multi.idx" && : > "$D/multi.mul"
  touch .done-data
fi

if [ ! -f .done-npm ]; then
  step "npm ci"
  (cd nvm/bot && npm ci --no-audit --no-fund --loglevel=error)
  touch .done-npm
fi
if [ ! -f secrets.env ]; then
  # At most 30 characters each: the UO login packet cuts anything longer.
  (umask 077 && printf 'NEO_OWNER_PASS=%s\nBOT_PASSWORD=%s\n' "$(openssl rand -hex 12)" "$(openssl rand -hex 12)" > secrets.env)
fi
step "ready"
