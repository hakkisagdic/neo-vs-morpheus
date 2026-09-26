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
  '{
    assemblyDirectories: ["./Assemblies"],
    dataDirectories: [$data],
    listeners: ["0.0.0.0:2593"],
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

jq --argjson id "${NEO_EXPANSION:-7}" 'map(select(.Id == $id)) | first' \
  Data/expansions.json > Configuration/expansion.json

if [ "$(cat Configuration/expansion.json)" = "null" ]; then
  echo "neo-server: unknown NEO_EXPANSION=${NEO_EXPANSION}" >&2
  exit 1
fi

echo "neo-server: expansion $(jq -r .Name Configuration/expansion.json), data $data_dir, address ${NEO_PUBLIC_ADDRESS:-127.0.0.1}"
exec dotnet ModernUO.dll "$@"
