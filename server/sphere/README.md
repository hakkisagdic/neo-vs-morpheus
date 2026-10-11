# SphereServer-X shard

A local [SphereServer-X](https://github.com/Sphereserver/Source-X) shard in Docker with the
[Scripts-X](https://github.com/Sphereserver/Scripts-X) pack, so the bots can play under Sphere's
rules as well as ModernUO's. It runs beside the ModernUO lanes (2593+i), on 127.0.0.1:2700.

The server builds from source, boots unattended with an owner account and creates bot accounts
on their first login (phase A). The arena commands the orchestrator sends (`[NeoDuel` and the
rest, C# in ModernUO's overlay) exist here as Sphere script with the same names, arguments and
replies, so `duel`, `series` and the rest run on this shard unchanged (phase B). The game rules
are still Sphere's own: [Combat under Sphere's rules](#combat-under-spheres-rules) lists what
differs from ModernUO and what the bot does not yet understand.

## Run

```bash
server/sphere/sphere.sh start            # builds the image if needed (8-15 min the first time), serves 127.0.0.1:2700
server/sphere/sphere.sh bot login Neo    # the bot CLI pointed at this shard (port and passwords)
server/sphere/sphere.sh bot series "$PWD/lab/series-sphere-smoke.json"   # a series, as on ModernUO
server/sphere/sphere.sh reload           # templates/*.json changed: read them again, no restart
server/sphere/sphere.sh console '#'      # a line on Sphere's console: '#' saves, '?' lists commands
server/sphere/sphere.sh logs --tail 50
server/sphere/sphere.sh stop             # saves the world, exits, removes the container
docker volume rm laya-sphere-data        # forget the world and the accounts
```

`bot` runs the bot's CLI in `bot/`, so files go with a full path. A second shard beside the
first: `SPHERE_PORT=2701 SPHERE_CONTAINER=laya-sphere-dev server/sphere/sphere.sh start`, with its
own volume `laya-sphere-dev-data`; every other command takes the same two settings.

In the game, GM commands start with `[` as on ModernUO (`[where`, `[NeoArena ring`): Sphere's
own `.` no longer works.

Without the wrapper the bot needs only the port and short passwords:
`cd bot && UO_PORT=2700 BOT_PASSWORD=<at most 16 characters> npm run nvm -- login Neo`.

**Passwords.** Sphere keeps at most 16 characters of a password (`MAX_ACCOUNT_PASSWORD_ENTER`,
the classic client's limit) but compares the whole password the client sends with them, so a
longer one never logs in, not even on the login that creates the account; the bot reports "bad
password". If `NEO_OWNER_PASS` or `BOT_PASSWORD` is longer, set `SPHERE_OWNER_PASS` and
`SPHERE_BOT_PASSWORD` (16 at most) in `.env`: `sphere.sh` uses them in place of the other two
and refuses longer ones.

**Sources.** The build reads `vendor/emulators/source-x` and `vendor/emulators/scripts-x`. They
are git-ignored and not in `deps.lock`, so `scripts/deps.sh sync` does not fetch them. The image
tag names both commits and a checksum of this folder's part (Dockerfile, entrypoint, scripts),
so a change here makes a new tag, which `start` builds (about 3 minutes; the C++ stage comes from
Docker's cache when the sources and `SPHERE_JOBS` are the same). Built and tested from:

```bash
git clone https://github.com/Sphereserver/Source-X.git vendor/emulators/source-x
git -C vendor/emulators/source-x checkout dd28a0ad53258adb55b548b1bd4df989065a1fe4
git clone https://github.com/Sphereserver/Scripts-X.git vendor/emulators/scripts-x
git -C vendor/emulators/scripts-x checkout 27e78bc896da239d3738fe02a6d6bf8e9045c16d
```

Other settings (port, container name, client files, the arena's place, limits) are listed at the
top of `sphere.sh`.

## How it is put together

- **`Dockerfile`**, two stages. The build stage (Debian trixie: CMake 3.31, GCC 14) runs
  upstream's CMake with upstream's toolchain file for the machine (`Linux-GNU-x86_64` or
  `Linux-GNU-AArch64`), build type `Nightly` (what upstream's CI publishes), Ninja with
  `SPHERE_JOBS` jobs (6). The runtime stage is `debian:trixie-slim` plus `libmariadb3` (Sphere
  links it even with MySQL off) and `jq`, and, read-only in `/opt/sphere`: the binary, upstream's
  `sphere.ini` and `sphereCrypt.ini`, the Scripts-X pack with our `scripts/*.scp` next to its
  `spheretables.scp`, `generate.sh`, and the synthetic world's `tiledata.mul` (`tiledata.sh`).
  The server runs as uid 10001. About 180 MB.
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
  `ClientMaxIP=64` (all bots come from Docker's gateway), `MaxPings=1000000` and
  `MaxConnectRequestsPerIP=0` (see below), `UseHttp=0`, `LocalIPAdmin=0`, `CommandPrefix=[`.
  Everything else, the game rules included, is upstream's template. Then it runs `generate.sh`
  (below).
- **Connection limits.** Upstream blocks an address for five minutes after 15 connections in a
  short while (`MaxPings`, decaying) or 50 without a five-minute pause (`MaxConnectRequestsPerIP`).
  Every bot login is two connections (login server, then game server), all from Docker's
  gateway, and every match logs its bots in again: two matches at once tripped the first limit
  ("Reject reason: MAXPINGS reached 16/15"), and a series would trip the second. The port is
  published on 127.0.0.1 only, so both are off.
- **Owner account.** `NEO_OWNER_USER` with Owner privilege (7) and the owner password, appended
  to `accounts/sphereacct.scp`, the account changes file Sphere reads after `sphereaccu.scp` at
  startup and folds into it at the next save: created on the first boot, re-applied on every later
  one. The bot's `Session.gm()` logs in with it as on ModernUO (character "Architect").
- **World.** Real client files when `/uodata` (`server/client-files` or `UO_DATA_DIR`, read-only)
  has `tiledata.mul` and `map0`; otherwise a synthetic flat world: every map in `sphere.ini`
  (Felucca, Trammel, Ilshenar, Malas, Tokuno, Ter Mur) as a sparse all-zero map file (land tile 0
  at z 0), empty statics and multis, and the image's `tiledata.mul`. Every map needs a file:
  Sphere moves the regions and teleporters of a map it cannot load onto Felucca, and `where` at
  Yew answered "The Great Stygian Abyss" until the other maps had files.
- **The synthetic `tiledata.mul`** (`tiledata.sh`, run in the image build like the synthetic data
  in `server/Dockerfile`, with the same layout and bytes) is the 7.0.9+ layout, all zeros except:
  the stone wall block 0x0080, the arena's obstacle, with Wall, Impassable and NoShoot and 20
  high; and Wearable plus the layer for the backpack and what the bots wear or hold (the
  templates' weapons, shield and leather armour, both graphics of each pair, the spellbook,
  robe, death shroud, a new character's clothes, the human hair and beard styles). ModernUO's
  clothes and spellbooks set their layer in code; Sphere takes every item's from tiledata, and
  saves the layer of worn items only from 25 up. With the zeroed file of phase A a new character
  carried its robe, clothes and spellbook in the pack, and every restart deleted all backpacks
  and their contents ("GC: Deleted ... i_backpack ... Item equipped in the trade window layer").
- **The arena scripts.** `scripts/neo_arena.scp` holds the commands (next section).
  `generate.sh`, run by the entrypoint at every start, writes `/sphere/generated/neo_generated.scp`
  (linked into the scripts folder): the arena's place from `NEO_ARENA_MAP`, `NEO_ARENA_X`,
  `NEO_ARENA_Y` (Felucca 1180,3610, as on ModernUO) and the character templates from
  `templates/*.json`, mounted read-only at `/templates` (`NEO_REAGENTS`, 200, is the built-in
  mage's reagents when there is no `mage.json`). `sphere.sh reload` writes it again and asks
  Sphere to resync, which reloads the script files that changed.
- **Data** in the volume `laya-sphere-data` (`/sphere/data`: `save/`, `accounts/`, `logs/`).
- **Console and stopping.** Sphere's standard input is a named pipe, so `sphere.sh console`
  types a line on its console. `sphere.sh stop` sends `X#`, which saves the world and exits.
  `docker stop` sends SIGHUP (the image's stop signal), which also saves first. Anything harsher
  loses what happened since the last save (`SavePeriod`, 20 minutes). Either way Sphere's
  shutdown ends in an abort right after the save ("Immediate abort requested", exit code 133),
  probably from cancelling its worker threads; the saved files are complete, as restarts show.

## The arena commands

Sphere has no C# overlay; each command is a `[FUNCTION]` in `scripts/neo_arena.scp`, run with the
GM's character as `SRC`, answering with `SRC.SYSMESSAGE NEO ...`, which the bot's journal reads
like ModernUO's `SendMessage`. They are open to GMs (`[PLEVEL 4]`), as on ModernUO.

| Command | Reply | In Sphere script |
|---|---|---|
| `[NeoPrep <name>` | `prep <name> 0x<serial>` | The player is the online client whose character has that name (any case). `RESURRECT 1` (raising the corpse when it lies there, else a new robe), `CURE 1`, the memory items on the spell layers removed (32 to 41: Bless, Curse and the other stat spells, Reactive Armor, Protection, Magic Reflection, Paralyze, ...; 42 poison, 44 potions, 51 webs, 53 a bandage at work), `ATTACKER.CLEAR`, hits, mana and stamina full, then the template's restock. |
| `[NeoDuel <a> <b> [distance] [slot]` | `duel <a> 0x.. x,y,z <b> 0x.. x,y,z Felucca` | Prep both, `GO` (z from the ground) to the west and east spots `distance` (8, 1 to 18) apart, facing each other. |
| `[NeoPlace <name> <west\|east> [distance] [slot]` | `place <name> 0x.. x,y,z` | Prep, then one spot. |
| `[NeoTemplate <name> [template]` | `template <name> <id> stats S/D/I [problems ...]` | Weapons, armour and a spellbook in hand come off (clothes stay, as on ModernUO), the pack empties, `STR`/`DEX`/`INT` (10 to 125), every skill 0 then the template's (in tenths: `MAGERY=1000`), the gear put on, the consumables checked; then prep. The older form `<name> <skill> [str dex int]` still means the mage. `error no template <id>` for an unknown one. |
| `[NeoMage [type] [distance] [slot]` | `mage <name> 0x.. x,y,z` | `SERV.NEWNPC` on the east spot with `HOME` there and `HOMEDIST=4`. `EvilMageLord` (the default) is `c_evilmage_lord`, `EvilMage` `c_evilmage`; anything else is taken as a CHARDEF. |
| `[NeoClear [radius] [slot]` | `clear <count>` | NPCs (`<NPC>` set) and corpses within `radius` (20, 1 to 60) of the slot's centre removed. |
| `[NeoArena <open\|pillars\|wall\|ring> [slot]` | `arena <layout> <count>` | Obstacles (tagged `neo_obstacle`) within 30 tiles removed, then the layout's stone wall blocks placed at z 0, never movable: the same offsets as ModernUO (4, 5 and 96 blocks). |

A slot (0 to 7) is one of eight arenas side by side, 80 tiles apart, as on ModernUO: slot 0 at
1180,3610 lies in Scripts-X's "Jhelom Territory", outside the guarded town. The searches around a
slot's centre (`FORCHARS`, `FORITEMS`) run from an invisible marker item put there for the
command. Errors answer as on ModernUO: `error missing player name`, `error <name> is not
online`, `error unknown layout ...`, `error unknown creature type ...`.

**Templates.** Sphere script cannot read JSON, so `generate.sh` turns every `templates/*.json`
into a branch of one function, `f_neo_tpl <template>,<step>,<skill>`, with steps for the stats and
skills, the gear, the consumables and a check that they exist; the player remembers its template
(`TAG.neo_template`; none: the mage) for the restock at every prep, which also puts back gear that
went missing. Names are ModernUO's, translated: all 58 skills by their position in both lists
(`EvalInt` is `EvaluatingIntel`, `MagicResist` `MagicResistance`, `Inscribe` `Inscription`,
`Swords` `Swordsmanship`, `Parry` `Parrying`, ...), and the items the templates use: reagents
(`BlackPearl` is `i_reag_black_pearl`, ...), potions (`GreaterHealPotion` is
`i_potion_HealGreat`, ...), bandages, arrows, leather armour, and weapons and shields by
ModernUO's graphic, which the bot knows them by (`Katana` is `013ff`, `Bow` `013b2`: Scripts-X
defines `i_katana` and `i_bow` on the other graphic of the pair). A name without a translation is
used as it is, so a template may also name a Sphere defname or item id; one that does not exist
comes back as `problems unknown item <name>`. Gear and consumables are newbie (Sphere's blessed):
death keeps them, and the corpse holds nothing.

## What works

Tested on 2026-10-10 and 11 on this Mac (arm64, Docker 29.8):

- The build: 237 steps, no compiler warning under upstream's `-Werror`; 8 to 15 minutes in all
  with other builds running on the machine, about 3 minutes with `-j4` alone.
- Startup in about 11 s: 757 script files, all six maps, "Startup complete", no errors besides
  eight upstream "Replacing existing VarStr" warnings (and, on a new volume, the missing saves).
  Idle: 100 MB of memory, about 6% of a core.
- The bot's login creates the account and the character; the next login plays it:

  ```
  $ UO_PORT=2700 BOT_PASSWORD=... npm run nvm -- login Neo
  Neo in world after 1464 ms: serial 0x1 at 633,858,0, health 30/30, mana 50/50 (new character)
  $ UO_PORT=2700 BOT_PASSWORD=... npm run nvm -- login Neo
  Neo in world after 1210 ms: serial 0x1 at 633,858,0, health 30/30, mana 50/50
  ```

- The owner account: `[where` answers "I am in Yew (633,858)", `[gm` "GM ON" and "GM OFF". A bot
  account's `[gm` is plain speech (privilege level 1).
- `console '#'` saves; after `stop` (console `X#`) or `docker stop` (SIGHUP) and a new `start`,
  accounts, characters and their backpacks are still there.
- A new character wears its robe, wizard's hat, shirt, pants, shoes, gloves and hair and holds its
  spellbook (the patched tiledata).
- Every command, through the bot's `Session.command` on a second shard (`laya-sphere-dev`,
  127.0.0.1:2701): the replies above, each in 5 to 400 ms (the first template on a new character
  up to 1 s). The mage, dexer and archer templates give the bots ModernUO's graphics (katana
  0x13ff, bow 0x13b2, leather 0x13cc..0x1db9, potions 0x0f0c/0x0f07/0x0f0b/0x0f0d, bandages,
  arrows, reagents) and skills; prep after `KILL` resurrects and restocks, prep after a Curse and
  Protection on the player removes both; `[NeoMage` spawns the evil mage lord, which fights;
  `[NeoClear` removes it and the corpses. The obstacles block: with `[NeoArena wall` a bot
  walking east stops at the wall (the server refuses the step), and a spell through it answers
  "Target is not in line of sight". The bots see the blocks as items 0x0080, the obstacles their
  moves are planned around.
- A series: `lab/series-sphere-smoke.json`, two entries of scripted mages, `Neo:rules@40:mage`
  against `Morpheus:rules@40:mage`, 3 rounds each, the second with pillars, two at a time in
  slots 0 and 1 (Neo/Morpheus and Trinity/Cypher), on a new volume. It plays to the end in about
  six minutes and writes a run for each entry to `runs/`:

  ```
  $ SPHERE_PORT=2701 SPHERE_CONTAINER=laya-sphere-dev server/sphere/sphere.sh bot series "$PWD/lab/series-sphere-smoke.json"
  == sphere: scripted mages, pillars (slot 1, 13:03-13:09)
  round 1: Neo (death, 92 s, health {"Neo":56,"Morpheus":0})
  round 2: Neo (time (more health left), 121 s, health {"Neo":63,"Morpheus":16})
  round 3: Morpheus (time (more health left), 120 s, health {"Neo":63,"Morpheus":64})
  warning: 5 of Morpheus's 79 casts were 0.3 s or more late (an effect left from an earlier round?); this run is not comparable
  result: Neo 2, Morpheus 1 of 3
  == sphere: scripted mages, open (slot 0, 13:03-13:09)
  round 1: Neo (time (more health left), 121 s, health {"Neo":59,"Morpheus":13})
  round 2: Neo (time (more health left), 121 s, health {"Neo":53,"Morpheus":30})
  round 3: Morpheus (time (more health left), 122 s, health {"Neo":17,"Morpheus":51})
  result: Neo 2, Morpheus 1 of 3
  ```

  Two earlier runs of the same series ended 2-1 (open) and 3-0 (pillars), then 2-1 and 0-3
  (Neo's wins first). The warning is the run checks' (below), not a fault of the arena.

## Combat under Sphere's rules

The rules are upstream's defaults: Sphere's own combat formulas (`CombatDamageEra`,
`CombatHitChanceEra`, `CombatSpeedEra` = 0), `MagicFlags=0` (no precasting, no OSI damage
formulas), no AOS features. What three runs of the series above (6 matches, 18 rounds) and a
measurement (each spell cast 4 times by a template mage, Magery and Eval Int 100, on another,
Resisting Spells 100) showed, against ModernUO's Mondain's Legacy rules, for which the bot's
brains and timings were made. "On ModernUO" compares with the same scripted mages on pillars
there (alastyr's runs of 2026-10-06).

- **Target first, cast after.** The target cursor comes right after the cast request (median 56
  to 112 ms per bot and match), and the cast delay runs after the target is chosen; on ModernUO
  the cursor comes when the delay has passed (median 1.25 s). The bot's caster takes the cursor
  as the cast done, so here it counts a spell as cast before its delay starts. The run checks
  then find the casts 0.9 to 1.2 s early on average (`castDriftMs`) and up to 5 a bot 2.5 s
  late, and called 2 of the 6 runs "not comparable".
- **Cast times** (Scripts-X `spells/spells_magery.scp`): 0.5, 0.8, 1.0, 1.3, 1.5, 1.8, 2.0 and
  2.3 s for circles 1 to 8, about half a second less than ModernUO's 1.0 to 2.75 s, but
  Explosion takes 3.8 s and the summons 7.5 s. Mana per circle is the same (4 to 50). Any damage
  during the delay interrupts the spell (`INTERRUPT=100.0,100.0`).
- **Failures are text.** Fizzles, disturbed spells, "Target is not in line of sight" and the like
  arrive as plain system messages, not localized (cliloc) ones, so the bot's caster sees none of
  them: of 927 casts, 920 were recorded as cast and 7 as timeouts, none as fizzled or disturbed.
  On ModernUO the same bots see about half their casts disturbed (20 to 45 a match).
- **Damage** (one cast each, 4 times; the target has 90 hits): Magic Arrow 9 to 13, Harm 12 to
  14, Fireball 11 to 15, Lightning 14 to 18, Energy Bolt 30 to 40, Explosion 26 to 33,
  Flamestrike 31 to 47. "You feel yourself resisting magical energy" came with about a quarter
  of them.
- **Hits** are the strength: 90 for the mage (ModernUO: 50 + strength / 2 = 95), 100 for the
  dexer. Mana is the intelligence and stamina the dexterity, as on ModernUO.
- **Mana comes back slowly** (`Regen1=20` in `sphere.ini`). Every bot of every match ran out
  (lowest 0); on ModernUO they never went below 6 to 51. With nothing to cast the scripted bots
  walk: 186 to 459 decisions and 75 to 279 moves a bot and match here, 63 to 99 decisions and 1
  to 4 moves on ModernUO.
- **Rounds** run long: 12 of the 18 went the full 120 s and were decided on health left; the 6
  deaths came after 69 to 102 s. On ModernUO every round of those runs ended in a death, after
  18 to 90 s.
- **Blocks** stop a step and a spell, and a diagonal step past a block's corner is refused (as
  ModernUO refuses it to players). On pillars the scripted bots' moves were refused far more
  often than in the open: 27 to 303 a bot and match, against 1 to 10.
- Starting characters differ too: start location 0 is Yew (633,858; Scripts-X `map0_starts.scp`);
  Sphere gives every skill a random value up to 20.0 before setting the four chosen ones and caps
  each starting stat at 60. Templates replace all of it.

Which rules the arena should copy (combat eras, `MagicFlags`, AOS features) and whether the bot
should learn Sphere's casting (target first, failures as text) are open.

## What does not work yet

- **The bot's brains under Sphere's rules**: see above. They play, and win and lose, but on
  ModernUO's timings, and they cannot tell a fizzle or an interrupted spell from a cast.
- **ClassicUO** would get the container's address (172.17.x.x) in the relay packet and could not
  reach the game server. The bot ignores that address and reconnects to the host it logged in
  through. Sphere replaces a loopback `ServIP` with the socket's own address, so the setting does
  not help; ClassicUO's option to ignore the relay address would.
- **Real client files are untested** (there are none here yet). Sphere reads the maps as `.mul`
  or `map<n>LegacyMUL.uop`, but tiledata, statics and multis only as `.mul`: a client that ships
  only `MultiCollection.uop` would need `multi.idx` and `multi.mul` extracted first, or Sphere
  stops with "File 'multi.idx' not found". The arena's obstacles then use the real tiledata, and
  lie at z 0 as on ModernUO, wherever the ground is.
- **Skill sessions** (`series` entries of kind `skill`, `train`) were not tried here.
- Only arm64 was built here; amd64 uses upstream's x86_64 toolchain, the one upstream's CI builds.
