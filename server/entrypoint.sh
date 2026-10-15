#!/usr/bin/env bash
# Writes ModernUO's configuration from the environment on every start, then runs the server.
# Nothing here asks questions, so the container boots unattended; the owner account comes
# from NEO_OWNER_USER / NEO_OWNER_PASS via the NeoArena overlay.
set -euo pipefail
cd /app

data_dir=/uodata
if [ ! -f "$data_dir/tiledata.mul" ]; then
  data_dir=/opt/arena-data
  echo "neo-server: no client files in /uodata, using the synthetic flat arena"
fi

mkdir -p Configuration World

jq -n \
  --arg data "$data_dir" \
  --arg name "${NEO_SERVER_NAME:-Neo vs Morpheus}" \
  --arg address "${NEO_PUBLIC_ADDRESS:-127.0.0.1}" \
  --arg listen "0.0.0.0:${NEO_PORT:-2593}" \
  '{
    assemblyDirectories: ["./Assemblies"],
    dataDirectories: [$data],
    listeners: [$listen],
    settings: {
      "serverListing.serverName": $name,
      "serverListing.address": $address,
      "serverListing.autoDetect": "False",
      "accountHandler.enableAutoAccountCreation": "True",
      "accountHandler.maxAccountsPerIP": "32",
      "world.savePath": "World/Saves",
      "autoArchive.backupPath": "World/Backups",
      "autoArchive.archivePath": "World/Archives",
      "autoArchive.hourlyRetention": "2",
      "autoArchive.dailyRetention": "2",
      "autoArchive.monthlyRetention": "0"
    }
  }' > Configuration/modernuo.json

# Optional faster leveling for tests: multiply every skill's gain factor (1 = the real rate).
gain="${NEO_SKILL_GAIN:-1}"
if [ "$gain" != "1" ]; then
  [ -f Data/skills.json.orig ] || cp Data/skills.json Data/skills.json.orig
  jq --argjson m "$gain" 'map(.GainFactor *= $m)' Data/skills.json.orig > Data/skills.json
  echo "neo-server: skill gain x$gain"
elif [ -f Data/skills.json.orig ]; then
  cp Data/skills.json.orig Data/skills.json
fi

jq --argjson id "${NEO_EXPANSION:-7}" 'map(select(.Id == $id)) | first' \
  Data/expansions.json > Configuration/expansion.json

if [ "$(cat Configuration/expansion.json)" = "null" ]; then
  echo "neo-server: unknown NEO_EXPANSION=${NEO_EXPANSION}" >&2
  exit 1
fi

# SosariaAI, server-side player bots (github.com/hakkisagdic/SosariaAI): the image carries the
# plugin in Assemblies and loads it only with NEO_SOSARIA=1. Its characters are saved in
# the world, and ModernUO stops at boot on a y/n question when a saved type is missing, so a world
# the plugin ran on needs it for good. The plugin's files (characters.json, brain.json, memory.db,
# nav graphs, activity.log) live in World/sosariaai, in the world volume, which marks such a world.
#   NEO_SOSARIA=1                 load the plugin; refused on a world saved without it
#   NEO_SOSARIA_MAPS=Trammel=10   the people of each facet; facets not named get none. It edits
#                                 characters.json, which the plugin writes at its first boot (when
#                                 nobody spawns: people come after First Time Setup), so it
#                                 applies from the next start on.
#   NEO_SOSARIA_LAYA_URL=<url>    a Laya server decides fight stances. Unset: the rules decide all.
#   NEO_SOSARIA_LAYA_MODEL        the model name that server serves (default typed-decisions)
#   NEO_SOSARIA_ACTIVITY_LOG=1|0  per-character lines in activity.log
sosaria=World/sosariaai
if [ "${NEO_SOSARIA:-}" = "1" ]; then
  if [ ! -d "$sosaria" ] && [ -n "$(find World/Saves -type f -print -quit 2>/dev/null)" ]; then
    echo "neo-server: NEO_SOSARIA=1 on a world saved without SosariaAI; give the plugin a world volume of its own" >&2
    exit 1
  fi
  mkdir -p "$sosaria"
  [ -L Configuration/sosariaai ] || rm -rf Configuration/sosariaai
  ln -sfn "/app/$sosaria" Configuration/sosariaai
  [ -f Data/assemblies.json.orig ] || cp Data/assemblies.json Data/assemblies.json.orig
  jq '. + ["SosariaAI.dll"]' Data/assemblies.json.orig > Data/assemblies.json

  # Laya on both routes: a System One provider on the chat route does nothing, so chat, plans and
  # persona writing are off and nothing is sent to a paid model. paid=false because the plugin
  # counts every address but loopback as paid and switches such a provider off without a key.
  [ -f "$sosaria/brain.json" ] || echo '{}' > "$sosaria/brain.json"
  if [ -n "${NEO_SOSARIA_LAYA_URL:-}" ]; then
    jq --arg url "$NEO_SOSARIA_LAYA_URL" --arg model "${NEO_SOSARIA_LAYA_MODEL:-typed-decisions}" '
      .enabled = true
      | .providers.laya = {api: "systemone", family: "laya", baseUrl: $url, model: $model, timeoutSeconds: 20, paid: false}
      | .route.chat = "laya" | .route.decision = "laya"
      | .personaWriter = false | .chatHelpMaxSeconds = 0' "$sosaria/brain.json" > "$sosaria/brain.json.new"
  else
    jq '.enabled = false' "$sosaria/brain.json" > "$sosaria/brain.json.new"
  fi
  mv "$sosaria/brain.json.new" "$sosaria/brain.json"

  if [ -f "$sosaria/characters.json" ]; then
    jq --arg maps "${NEO_SOSARIA_MAPS:-}" --arg log "${NEO_SOSARIA_ACTIVITY_LOG:-}" '
      ($maps | split(",") | map(select(length > 0) | split("=") | {facet: .[0], count: (.[1] | tonumber)})) as $want
      | if ($want | length) == 0 then . else
          reduce $want[] as $w (.maps = ((.maps // {}) | with_entries(.value.enabled = false));
            (((.maps | keys | map(select(ascii_downcase == ($w.facet | ascii_downcase)))) | first) // $w.facet) as $key
            | .maps[$key] = ((.maps[$key] // {}) | .enabled = ($w.count > 0) | .count = $w.count
                | if (.pkCount // 0) > $w.count then .pkCount = $w.count else . end))
        end
      | if $log == "" then . else .logActivity = ($log == "1") end' \
      "$sosaria/characters.json" > "$sosaria/characters.json.new"
    mv "$sosaria/characters.json.new" "$sosaria/characters.json"
  else
    echo "neo-server: SosariaAI writes its characters.json at this first boot; NEO_SOSARIA_MAPS applies from the next start"
  fi
  echo "neo-server: SosariaAI on, people ${NEO_SOSARIA_MAPS:-as characters.json says}, fight stances by ${NEO_SOSARIA_LAYA_URL:-the rules}, no chat model"
elif [ -d "$sosaria" ]; then
  echo "neo-server: this world holds SosariaAI characters; start it with NEO_SOSARIA=1" >&2
  exit 1
elif [ -f Data/assemblies.json.orig ]; then
  cp Data/assemblies.json.orig Data/assemblies.json
fi

echo "neo-server: expansion $(jq -r .Name Configuration/expansion.json), data $data_dir, address ${NEO_PUBLIC_ADDRESS:-127.0.0.1}"
exec dotnet ModernUO.dll "$@"
