# SphereServer-X shard

A local [SphereServer-X](https://github.com/Sphereserver/Source-X) shard in Docker with the
[Scripts-X](https://github.com/Sphereserver/Scripts-X) pack, so the bots can play under Sphere's
rules as well as ModernUO's. It runs beside the ModernUO lanes (2593+i), on 127.0.0.1:2700.

This is phase A: the server builds from source, boots unattended with an owner account, creates
bot accounts on their first login, and the bot logs in and stands in the world. The arena
commands the orchestrator sends (`[NeoDuel` and the rest) are C# compiled into ModernUO and do
not exist here yet; [phase B](#phase-b-the-arena-commands-in-sphere-script) lists what they need.

## Run

```bash
server/sphere/sphere.sh start            # builds the image the first time (8-15 min), serves 127.0.0.1:2700
server/sphere/sphere.sh bot login Neo    # the bot CLI pointed at this shard (port and passwords)
server/sphere/sphere.sh console '#'      # a line on Sphere's console: '#' saves, '?' lists commands
server/sphere/sphere.sh logs --tail 50
server/sphere/sphere.sh stop             # saves the world, exits, removes the container
docker volume rm laya-sphere-data        # forget the world and the accounts
```

Without the wrapper the bot needs only the port and a short password:
`cd bot && UO_PORT=2700 BOT_PASSWORD=<at most 16 characters> npm run nvm -- login Neo`.

**Passwords.** Sphere keeps at most 16 characters of a password (`MAX_ACCOUNT_PASSWORD_ENTER`,
the classic client's limit) but compares the whole password the client sends with them, so a
longer one never logs in, not even on the login that creates the account; the bot reports "bad
password". If `NEO_OWNER_PASS` or `BOT_PASSWORD` is longer, set `SPHERE_OWNER_PASS` and
`SPHERE_BOT_PASSWORD` (16 at most) in `.env`: `sphere.sh` uses them in place of the other two
and refuses longer ones.

**Sources.** The build reads `vendor/emulators/source-x` and `vendor/emulators/scripts-x`. They
are git-ignored and not in `deps.lock`, so `scripts/deps.sh sync` does not fetch them. The image
tag names both commits; `laya-sphere:dd28a0a-27e78bc` was built and tested from:

```bash
git clone https://github.com/Sphereserver/Source-X.git vendor/emulators/source-x
git -C vendor/emulators/source-x checkout dd28a0ad53258adb55b548b1bd4df989065a1fe4
git clone https://github.com/Sphereserver/Scripts-X.git vendor/emulators/scripts-x
git -C vendor/emulators/scripts-x checkout 27e78bc896da239d3738fe02a6d6bf8e9045c16d
```

Other settings (port, container name, client files, limits) are listed at the top of `sphere.sh`.

## How it is put together

- **`Dockerfile`**, two stages. The build stage (Debian trixie: CMake 3.31, GCC 14) runs
  upstream's CMake with upstream's toolchain file for the machine (`Linux-GNU-x86_64` or
  `Linux-GNU-AArch64`), build type `Nightly` (what upstream's CI publishes), Ninja with 6 jobs.
  The runtime stage is `debian:trixie-slim` plus `libmariadb3` (Sphere links it even with MySQL
  off) and, read-only in `/opt/sphere`, the binary, upstream's `sphere.ini` and `sphereCrypt.ini`
  and the Scripts-X pack. The server runs as uid 10001. About 180 MB.
- Two compiler flags, no change to upstream's files:
  - `-U_SANITIZERS`. Upstream's `CMakeLists.txt` writes
    `set(ENABLED_SANITIZER FALSE CACHE INTERNAL BOOL "Am i using a sanitizer?")`; with the extra
    argument CMake does not take the CACHE form and sets a five-item list, which counts as true,
    so every build gets `_SANITIZERS` and Sphere never installs its signal handlers
    (`SetUnixSignals` in `src/common/CException.cpp`). SIGHUP then killed the server at once
    instead of saving the world. This probably affects upstream's own Linux nightlies too.
  - `-fsigned-char` on ARM: `char` is signed on x86 and Apple ARM, where upstream builds and
    tests, and unsigned on Linux ARM unless told otherwise.
- **`entrypoint.sh`** writes `sphere.ini` at every start: upstream's template without its example
  `[SERVERS]` entry and status web page, plus a second `[SPHERE]` section with ours (later keys
  win): `AGREE=1`, `ServIP=0.0.0.0` and the port, paths, `AccApp=2` (an account is made on its
  first login), `Md5Passwords=1`, `UseNoCrypt=1` (the bot's client does not encrypt),
  `ClientMaxIP=64` (all bots come from Docker's gateway), `UseHttp=0`, `LocalIPAdmin=0`.
  Everything else, the game rules included, is upstream's template.
- **Owner account.** `NEO_OWNER_USER` with Owner privilege (7) and the owner password, appended
  to `accounts/sphereacct.scp`, the account changes file Sphere reads after `sphereaccu.scp` at
  startup and folds into it at the next save: created on the first boot, re-applied on every later
  one. The bot's `Session.gm()` logs in with it as on ModernUO (character "Architect").
- **World.** Real client files when `/uodata` (`server/client-files` or `UO_DATA_DIR`, read-only)
  has `tiledata.mul` and `map0`; otherwise a synthetic flat world: every map in `sphere.ini`
  (Felucca, Trammel, Ilshenar, Malas, Tokuno, Ter Mur) as a sparse all-zero map file (land tile 0
  at z 0), empty statics and multis, and a zeroed `tiledata.mul`. Every map needs a file: Sphere
  moves the regions and teleporters of a map it cannot load onto Felucca, and `.where` at Yew
  answered "The Great Stygian Abyss" until the other maps had files.
- **Data** in the volume `laya-sphere-data` (`/sphere/data`: `save/`, `accounts/`, `logs/`).
- **Console and stopping.** Sphere's standard input is a named pipe, so `sphere.sh console`
  types a line on its console. `sphere.sh stop` sends `X#`, which saves the world and exits.
  `docker stop` sends SIGHUP (the image's stop signal), which also saves first. Anything harsher
  loses what happened since the last save (`SavePeriod`, 20 minutes). Either way Sphere's
  shutdown ends in an abort right after the save ("Immediate abort requested", exit code 133),
  probably from cancelling its worker threads; the saved files are complete, as restarts show.

## What works

Tested on 2026-10-10 on this Mac (arm64, Docker 29.8):

- The build: 237 steps, no compiler warning under upstream's `-Werror`; 8 to 15 minutes in all
  with other builds running on the machine.
- Startup in about 11 s: 755 script files, all six maps, "Startup complete", no errors besides
  eight upstream "Replacing existing VarStr" warnings (and, on a new volume, the missing saves).
  Idle: 100 MB of memory, about 6% of a core.
- The bot's login creates the account and the character; the next login plays it:

  ```
  $ UO_PORT=2700 BOT_PASSWORD=... npm run nvm -- login Neo
  Neo in world after 1464 ms: serial 0x1 at 633,858,0, health 30/30, mana 50/50 (new character)
  $ UO_PORT=2700 BOT_PASSWORD=... npm run nvm -- login Neo
  Neo in world after 1210 ms: serial 0x1 at 633,858,0, health 30/30, mana 50/50
  ```

  Server log: `Login for account 'neo' ... ConnectionType: ServerList`, then `CharList/Game`,
  `Account 'neo' created new char 'Neo' [01]`, `Character startup for account 'neo', char 'Neo'`.
  With a 24-character password the same command answers `login rejected: bad password`.
- The owner account: `.where` answers "I am in Yew (633,858)", `.gm` "GM ON" and "GM OFF". A bot
  account's `.gm` is plain speech (privilege level 1).
- `console '#'` saves; after `stop` (console `X#`) or `docker stop` (SIGHUP) and a new `start`,
  accounts and characters are still there (`Startup complete (items=5, chars=3, accounts=3)`).

No change to the bot was needed. What was checked against Sphere's source: the 0xEF seed with
the client version and the unencrypted 0x80 (allowed by `UseNoCrypt=1`; the version from the
seed reaches the game login through the account); the server list and the 0x8C relay (port =
`ServPort`, so host and container port must match, as on the ModernUO lanes; the key is a CRC of
server and account name, checked on the game login); seed plus 0x91; the 0xA9 character list
(always at least 5 slots); 0xF8 character creation (the same 106 bytes as ModernUO's); 0x5D,
0x1B and 0x55; Huffman compression per packet with the terminal symbol.

## What does not work yet

- **The arena commands**: phase B, below.
- **ClassicUO** would get the container's address (172.17.x.x) in the relay packet and could not
  reach the game server. The bot ignores that address and reconnects to the host it logged in
  through. Sphere replaces a loopback `ServIP` with the socket's own address, so the setting does
  not help; ClassicUO's option to ignore the relay address would.
- **The synthetic world is barer than ModernUO's.** With a zeroed `tiledata.mul` no item has
  tiledata flags or a layer. Sphere still creates every item (types come from the scripts), but
  only what has an explicit layer is worn: a new character carries its backpack, and its hair,
  clothes, dagger and spellbook all land inside it. Nothing blocks walking or line of sight
  either. `server/Dockerfile` patches the entries ModernUO's arena needs (stone wall 0x0080, the
  templates' gear, Wearable flag plus layer); the same bytes would serve here. With real client
  files none of this applies.
- **The rules are upstream's defaults, not ModernUO's.** Combat formulas are Sphere's own
  (`CombatDamageEra`, `CombatHitChanceEra`, `CombatSpeedEra` = 0), `MagicFlags=0` (the target
  comes first and the cast after, casters may walk, no precasting, no OSI damage formulas), the AOS
  features are off. The bot's brains and timings were made for ModernUO's Mondain's Legacy rules.
- **Character creation differs.** Start location 0 is Yew (633,858; Scripts-X `map0_starts.scp`);
  Sphere gives every skill a random value up to 20.0 before setting the four chosen ones and caps
  each starting stat at 60.
- **Real client files are untested** (there are none here yet). Sphere reads the maps as `.mul`
  or `map<n>LegacyMUL.uop`, but tiledata, statics and multis only as `.mul`: a client that ships
  only `MultiCollection.uop` would need `multi.idx` and `multi.mul` extracted first, or Sphere
  stops with "File 'multi.idx' not found".
- Only arm64 was built here; amd64 uses upstream's x86_64 toolchain, the one upstream's CI builds.

## Phase B: the arena commands in Sphere script

Sphere has no C# overlay; the same commands become script functions. A `[FUNCTION NeoDuel]` is a
GM command: it runs with `SRC` = the GM's character and its arguments in `<ARGS>` and
`<ARGV[n]>`, and answers with `SRC.SYSMESSAGE NEO ...`, which the bot's journal reads like
ModernUO's `SendMessage`. Every name below exists in Source-X or Scripts-X at the pinned commits.

| ModernUO (`server/overlay`) | Sphere script |
|---|---|
| Owner account from the environment | Done (entrypoint, account changes file). |
| `[NeoPrep <name>`: resurrect, heal, cure, end lasting spells, restock | Find the player: a bot's account is its name in lower case, so `SERV.ACCOUNT.<account>.LASTCHARUID` and `ISONLINE`; or `SERV.ALLCLIENTS` / `FORPLAYERS`. Then `RESURRECT`, `HITS=<MAXHITS>`, `MANA=<MAXMANA>`, `STAM=<MAXSTAM>`, `CURE`. Lasting spells are memory items on the spell layers (`LAYER_SPELL_STATS` 32 to `LAYER_SPELL_Summon` 41, poison 42): `FINDLAYER.<n>.REMOVE`. Restock with `NEWITEM i_reag_black_pearl,<n>` and friends into the pack (`FINDLAYER.21`); a full spellbook is `i_spellbook` with `MORE1` and `MORE2` = `0ffffffff` (the spell bit masks). |
| `[NeoDuel <a> <b> [distance] [slot]`, `[NeoPlace <name> <west\|east> ...` | Prep, then `GO x,y,z,map` (or `P=`) and `DIR=`; positions with `<EVAL ...>` from the centre plus 80 tiles per slot. |
| `[NeoTemplate <name> [template]` | `STR=`, `DEX=`, `INT=`; skills by key in tenths (`MAGERY=1000`); gear with `NEWITEM` and `EQUIP`. Sphere script cannot read JSON, so the entrypoint should turn `templates/*.json` into a generated `.scp` (one function per template, with jq) and map the names: skills `EvalInt` to `EvaluatingIntel`, `MagicResist` to `MagicResistance`, `Inscribe` to `Inscription`, `Swords` to `Swordsmanship`, `Parry` to `Parrying`; items `BlackPearl` to `i_reag_black_pearl`, `Katana` to `i_katana`, and so on. |
| `[NeoMage [type] ...` | `SERV.NEWNPC c_evilmage_lord` (or `c_evilmage`, Scripts-X `npcs/c_monster_lbr.scp`), `NEW.P=`, `NEW.HOME=`. |
| `[NeoClear [radius] [slot]` | From an object at the arena centre: `FORCHARS <radius>` and `REMOVE` what is not a player (`ISPLAYER`); `FORITEMS <radius>` and `REMOVE` corpses (`TYPE == t_corpse`). |
| `[NeoArena <open\|pillars\|wall\|ring> [slot]` | `SERV.NEWITEM` with `NEW.P=`, `NEW.ATTR` (never movable) and a `TAG` to find them again with `FORITEMS`. To block walking and line of sight on the synthetic world the item needs its tiledata flags (see above). |

The plumbing around them:

- **Where the scripts go.** `server/sphere/scripts/*.scp`, copied into the image next to
  Scripts-X's `spheretables.scp`: Sphere loads every `.scp` in the `ScpFiles` root after the
  resources `spheretables.scp` lists, so Scripts-X's definitions are known and its files stay
  untouched.
- **The command prefix.** `CommandPrefix=[` in `sphere.ini` lets the orchestrator send
  `[NeoDuel ...` unchanged (Sphere's default is `.`); otherwise the bot's prefix becomes a
  setting. Functions not listed in a `[PLEVEL n]` section need `DefaultCommandLevel` (7), the
  owner's level; listing them under `[PLEVEL 4]` opens them to GMs.
- **The rules to play under**: which shard the arena should copy (combat eras, `MagicFlags`, AOS
  features), and the bot's brains for Sphere's casting (no cast delay, target first).
- **Parallel arenas** are slots on one server, as on ModernUO; more servers would be more
  containers with their own port and volume (`SPHERE_PORT`, `SPHERE_CONTAINER`).
