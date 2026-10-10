#!/usr/bin/env bash
# Writes sphere.ini and the owner account from the environment on every start, then runs
# SphereServer-X in the foreground. Nothing asks questions, so the container boots unattended.
#
#   SPHERE_PORT          port Sphere listens on and hands clients for the game connection (2593)
#   SPHERE_SERVER_NAME   shard name in the server list ("Laya Sphere")
#   NEO_OWNER_USER       owner (GM) account, Owner privilege level (architect)
#   NEO_OWNER_PASS       its password; Sphere keeps at most 16 characters of a password
#
# Bot accounts are created on their first login (AccApp=2), as on the ModernUO arena.
set -euo pipefail

port="${SPHERE_PORT:-2593}"
name="${SPHERE_SERVER_NAME:-Laya Sphere}"
owner_user="${NEO_OWNER_USER:-architect}"
owner_pass="${NEO_OWNER_PASS:-}"
dist=/opt/sphere
data=/sphere/data

fail() {
  echo "laya-sphere: $*" >&2
  exit 1
}

case "$port" in '' | *[!0-9]*) fail "SPHERE_PORT must be a number, got '$port'" ;; esac
case "$name" in '' | *[!A-Za-z0-9\ ._-]*) fail "SPHERE_SERVER_NAME may hold letters, digits, spaces and . _ -" ;; esac

# Values go into a Sphere script, where // starts a comment and <...> is evaluated, so the
# owner's name and password are limited to plain characters. Sphere stores at most 16 password
# characters and then compares the whole password the client sends with them: a longer
# password could never log in.
case "$owner_user" in '' | [0-9]* | *[!A-Za-z0-9_]*) fail "NEO_OWNER_USER must be letters, digits or _ and not start with a digit" ;; esac
if [ -n "$owner_pass" ]; then
  case "$owner_pass" in *[!A-Za-z0-9_.!@#%^*+=?~-]*) fail "NEO_OWNER_PASS may hold letters, digits and _.!@#%^*+=?~-" ;; esac
  [ "${#owner_pass}" -le 16 ] || fail "NEO_OWNER_PASS has ${#owner_pass} characters; Sphere accepts at most 16"
fi

mkdir -p "$data/save" "$data/accounts" "$data/logs"

# Client files: real ones when /uodata has them, else a synthetic flat world (below).
if [ -f /uodata/tiledata.mul ] && { [ -f /uodata/map0.mul ] || [ -f /uodata/map0LegacyMUL.uop ]; }; then
  mul=/uodata
  synthetic=0
  echo "laya-sphere: client files from /uodata"
else
  mul=/sphere/arena-data
  synthetic=1
fi

# sphere.ini: upstream's template as shipped, minus its example [SERVERS] entry (listing our own
# name there would move us to 127.0.0.1:2593) and its status web page, then our settings in a
# second [SPHERE] section; later keys win.
awk '
  /^\[/ { skip = ($0 ~ /^\[(SERVERS|WEBPAGE|EOF)/) }
  skip { next }
  { print }
' "$dist/sphere.ini.dist" > sphere.ini

cat >> sphere.ini <<EOF

///////////////////////////////////////////////////////////////
//////// laya-sphere (server/sphere/entrypoint.sh): written at every start
///////////////////////////////////////////////////////////////
[SPHERE]
// This is a nightly build; Sphere refuses to start until this is confirmed.
AGREE=1
ServName=$name
// Listen on every interface of the container; Docker publishes the port on 127.0.0.1 only.
ServIP=0.0.0.0
ServPort=$port
ScpFiles=$dist/scripts/
MulFiles=$mul/
WorldSave=$data/save/
AcctFiles=$data/accounts/
Log=$data/logs/
// Accounts are created on their first login, like the ModernUO arena's; passwords are stored
// as MD5 hashes rather than in plain text.
AccApp=2
Md5Passwords=1
// Many bots share one address (Docker's gateway).
ClientMaxIP=64
ConnectingMaxIP=32
// The bots' client is unencrypted; real clients may still use encryption.
UseCrypt=1
UseNoCrypt=1
// No status web page (it would be written into the read-only scripts folder) and no
// password-free console for local addresses.
UseHttp=0
LocalIPAdmin=0

[EOF]
EOF

ln -sf "$dist/sphereCrypt.ini" sphereCrypt.ini

# The synthetic world. Sphere refuses to start without map0, staidx0.mul, statics0.mul,
# tiledata.mul, multi.idx and multi.mul, and moves the regions and teleporters of a map it has
# no files for onto Felucca, so every map of sphere.ini gets a file: all land tile 0 at z 0
# (MapN=width,height,sector size,file number,...; blocks of 8x8 tiles, 196 bytes each). No
# statics, no multis, and a zeroed 7.0.9+ tiledata.mul, so no tile has a flag and everything is
# walkable. Sparse files: the zeros take no disk.
if [ "$synthetic" = 1 ]; then
  rm -rf "$mul"
  mkdir -p "$mul"
  awk -F '[=,]' 'tolower($1) ~ /^[ \t]*map[0-9]+[ \t]*$/ { print $5 + 0, $2 + 0, $3 + 0 }' sphere.ini |
    while read -r file width height; do
      columns=$((width / 8))
      truncate -s $((columns * (height / 8) * 196)) "$mul/map$file.mul"
      : > "$mul/staidx$file.mul"
      : > "$mul/statics$file.mul"
    done
  # Sphere loads map0 even without a Map0 line: 7168x4096, 896x512 blocks.
  [ -f "$mul/map0.mul" ] || truncate -s $((896 * 512 * 196)) "$mul/map0.mul"
  : > "$mul/staidx0.mul"
  : > "$mul/statics0.mul"
  truncate -s 3188736 "$mul/tiledata.mul"
  : > "$mul/multi.idx"
  : > "$mul/multi.mul"
  echo "laya-sphere: no client files in /uodata, using a synthetic flat world ($(cd "$mul" && echo map*.mul))"
fi

# The owner account goes into the account changes file, which Sphere reads after
# sphereaccu.scp at startup and folds into it at the next save: created on the first boot,
# its privilege level and password re-applied on every later one.
if [ -n "$owner_pass" ]; then
  cat >> "$data/accounts/sphereacct.scp" <<EOF

[$owner_user]
PLEVEL=Owner
PASSWORD=$owner_pass
EOF
  echo "laya-sphere: owner account $owner_user"
else
  echo "laya-sphere: NEO_OWNER_PASS is not set; no owner account" >&2
fi

# Console commands reach Sphere through a named pipe as its standard input, e.g.
# `docker exec laya-sphere bash -c 'echo "#" > /sphere/console'` saves the world and "X#"
# saves and exits (server/sphere/sphere.sh console|stop). Opened read-write, so the pipe never
# reports end of file while nobody writes.
rm -f /sphere/console
mkfifo -m 600 /sphere/console

echo "laya-sphere: $name on port $port"
exec "$dist/SphereSvrX64_nightly" "$@" <>/sphere/console
