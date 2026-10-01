#!/bin/bash
# lane.sh <i> <series.json> [series options]: arena server i on 127.0.0.1:2593+i, started if it is
# not running, then the series on it with Laya server i (127.0.0.1:8001+i, see model.sh). The owner
# and bot passwords (and LAYA_API_KEY, if the model servers want one) come from secrets.env.
#   lane.sh 0 /content/arena/nvm/lab/series-mage12.json --parallel 8
set -euo pipefail
A=${ARENA_DIR:-/content/arena}; i=$1; series=$2; shift 2
export DOTNET_ROOT=$A/dotnet PATH=$A/dotnet:$A/node/bin:$PATH DOTNET_CLI_TELEMETRY_OPTOUT=1
set -a; . "$A/secrets.env"; set +a
port=$((2593 + i)); d=$A/uo-$i
up() { (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; }
if ! up; then
  [ -d "$d" ] || cp -r "$A/modernuo/Distribution" "$d"
  mkdir -p "$d/Configuration" "$d/World"
  ln -sfn "$A/nvm/templates" "$d/NeoTemplates"
  jq -n --arg data "$A/arena-data" --arg listen "127.0.0.1:$port" --arg name "arena lab $i" '{
    assemblyDirectories: ["./Assemblies"], dataDirectories: [$data], listeners: [$listen],
    settings: {
      "serverListing.serverName": $name, "serverListing.address": "127.0.0.1", "serverListing.autoDetect": "False",
      "accountHandler.enableAutoAccountCreation": "True", "accountHandler.maxAccountsPerIP": "32",
      "world.savePath": "World/Saves", "autoArchive.backupPath": "World/Backups", "autoArchive.archivePath": "World/Archives",
      "autoArchive.hourlyRetention": "2", "autoArchive.dailyRetention": "2", "autoArchive.monthlyRetention": "0"
    } }' > "$d/Configuration/modernuo.json"
  jq --argjson id 7 'map(select(.Id == $id)) | first' "$d/Data/expansions.json" > "$d/Configuration/expansion.json"
  (cd "$d" && export NEO_OWNER_USER=architect NEO_EXPANSION=7 NEO_REAGENTS=200 && exec -a "arena-uo-$i" dotnet ModernUO.dll) \
    > "$A/lane-$i.server.log" 2>&1 < /dev/null &
  for _ in $(seq 150); do up && break; sleep 2; done
  up || { echo "arena server $i did not open port $port"; exit 1; }
  echo "arena server $i up on $port"
fi
cd "$A/nvm/bot"
export UO_HOST=127.0.0.1 UO_PORT=$port LAYA_URL=http://127.0.0.1:$((8001 + i)) NEO_OWNER_USER=architect \
  RULES_REACTION_MS=${RULES_REACTION_MS:-100} MONITOR_PORT=$((9000 + 100 * i))
exec -a "arena-series-$i" node src/cli.ts series "$series" "$@"
