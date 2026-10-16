#!/usr/bin/env python3
"""A model plays Ultima Online through Navrey with game tools only, and every step is recorded:

    python3 lab/uo_agent.py gemma --model gemma4-32k --minutes 30
    python3 lab/uo_agent.py qwen --model qwen3.8:27b --minutes 30
    python3 lab/uo_agent.py fable --claude claude-fable-5-1 --minutes 30
    python3 lab/uo_agent.py gemma-laya --name Gemma --model gemma4-32k --laya http://127.0.0.1:8100
    python3 lab/uo_agent.py gemma-ground --name Gemma --model gemma4-32k --laya http://127.0.0.1:8100 --ground first

With --laya the model also gets `fight`, which hands a fight to Laya (a Laya server at that URL):
the model chooses what to fight and with which tactics, Laya makes every move of the fight
(bot/src/navrey/fight.ts, `npm run nvm -- fight`), and the fight's decisions go to fights.jsonl.

The model gets four tools and nothing else: no shell, no files. `command` sends one Navrey client
command (one line, a few client-side ones refused), `look` reads the character and its surroundings
from Navrey's state files, `wait` lets time pass and returns what happened, and `decide` notes a
decision before the model acts on it. Agent frameworks with a shell (opencode) could not keep a
local model inside the game: it read and wrote files outside Navrey's folder despite their rules.

Every session starts the same way unless --as-is: the character alive, refitted as a young
swordsman (templates/warrior-novice.json) and standing in New Haven, through the world server's GM
(lab/world.sh gm). With --ground NAME the session is played on a training ground instead
(data/grounds/NAME.json), which the server keeps ([NeoGround, server/overlay/NeoGround.cs): its creatures
come back by ModernUO's own spawners, strangers are removed, and the character is back at the start after a death.

Any OpenAI-compatible endpoint with tool calls serves (Ollama by default). A Claude model plays
through Claude Code with its own tools switched off and these four served to it over MCP by this
same script (`--serve`), so both kinds of player get the same instructions and the same tools. The
client must already be running and in the world (~/Projects/navrey, `cuo -agent`).

Everything lands in ~/UO/sessions/<stamp>-<player>/:
- decisions.jsonl: each decision with its reason and what the character saw and was at that moment,
  the raw material for teaching small models the slow decisions;
- agent.jsonl: every model reply and tool call with its result and timing (claude.jsonl: Claude
  Code's own transcript);
- state.jsonl / world.jsonl: Navrey's state files every 2 s / 5 s; cuolog.txt: the client's log.
Standard library only.
"""
import argparse
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

import bestiary
import loot
import skillplan

CMD, LOG = "/tmp/cuocmd", "/tmp/cuolog"
STATE, WORLD = "/tmp/cuostate.json", "/tmp/cuoworld.json"
STAMP = re.compile(r"^\[\d{2}:\d{2}:\d{2}\.\d{3}\] ")
# Client-side commands that are not play: the window (the person watching keeps it) and the log level
# (the replies are read from the log).
REFUSED = {"hide", "show", "quiet", "q", "verbose", "record"}
MAPS = ["Felucca", "Trammel", "Ilshenar", "Malas", "Tokuno", "Ter Mur"]
COMMANDS = {"mobiles", "attack", "war", "goto", "gotoexact", "travel", "closest", "findpoi", "walk", "stop", "use", "target",
            "container", "get", "equip", "unequip", "inv", "status", "skills", "say", "shop", "buy", "sell", "selllist", "click",
            "drop", "props", "canwalk", "path", "opendoor", "dead", "gumps", "gumpresponse", "items", "nearest", "attacknearest",
            "backpack", "hp", "los", "useskill", "cast", "dropground", "mount", "dismount", "pos"}
HISTORY_CHARS = 60_000  # the most conversation kept beyond the instructions, about 17k tokens
SESSIONS = os.path.expanduser("~/UO/sessions")
POI = os.path.expanduser("~/UO/poi")  # lab/poi.py's output, the folder Navrey's settings.json names
PLACES = None
BEASTS = None
# Commands that move the character or act with it: while Laya answers an attack (Guard) they wait for that
# fight to end, and then they are not sent, since the model chose them before it knew of the fight.
ACTS = {"attack", "attacknearest", "war", "goto", "gotoexact", "travel", "walk", "stop", "use", "target", "get", "equip", "unequip",
        "say", "buy", "sell", "drop", "opendoor", "gumpresponse"}
LOOT_TOOL = {"type": "function", "function": {
    "name": "loot", "description": "Take what is worth taking from a corpse or container next to you (within 2 tiles): "
    "gold, gems, treasure maps and magic items first, then whatever sells best for its weight, as much as you can carry. "
    "Returns what you took and what you left.",
    "parameters": {"type": "object", "properties": {
        "container": {"type": "string", "description": "the corpse's or container's serial, e.g. 0x4004C7AF"}},
        "required": ["container"]}}}
# The fighter the danger estimates are for: templates/warrior-novice.json's skills, a viking sword.
FIGHTER = {"swords": 50, "tactics": 50, "anatomy": 50, "parry": 30, "damage": 16, "swing": 3.75}
WORLD_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "world.sh")
FIRST = "You are in the game now. Begin: look around and decide what to do."
REREAD = ("Your last reply could not be read. Call only your tools (look, command, wait, decide, loot and, if you have it, "
          "fight); a game command such as status, inv, container or target goes inside `command`, e.g. "
          "command {\"command\": \"status\"}.")
BOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bot")
FIGHT = """

Fights: you have fast fighting reflexes, Laya, a small model that decides every move of a fight in
a few hundredths of a second. `fight` hands it one creature: you choose what to fight, when, and how
carefully (tactics: cautious heals early and may run when hurt; balanced; aggressive fights on), and
Laya fights until the creature dies, you die, you get away or it goes out of view, then tells you
how it went. Use `fight` rather than `attack` for anything that fights back, and start cautious
against a creature you do not know yet. When something attacks you and Laya is not fighting already,
Laya fights back at once (cautiously against a dangerous attacker), and your next tool result tells
you how it went; a command you sent meanwhile is not carried out."""
FIGHT_TOOL = {"type": "function", "function": {
    "name": "fight", "description": "Hand a fight with one creature to Laya, which makes every move (swing, bandage, potion, retreat) "
    "until it ends, within the tactics you choose. Returns how it ended and your health.",
    "parameters": {"type": "object", "properties": {
        "target": {"type": "string", "description": "the creature's serial, e.g. 0x0000925D"},
        "tactics": {"type": "string", "enum": ["cautious", "balanced", "aggressive"]},
        "max_seconds": {"type": "integer", "minimum": 10, "maximum": 180}},
        "required": ["target"]}}}

SYSTEM = """You are playing Ultima Online yourself, as a player would, on a private test shard (ModernUO,
Mondain's Legacy rules). Nobody else is online. Your character {name} is a young swordsman: about
50 Swordsmanship, Tactics, Healing and Anatomy, a viking sword, a shield, leather armour, 60
bandages, three greater heal potions and 1,000 gold. {start}

{goal}

Before every decision that matters (where to go, what to fight, when to run, heal, loot, restock or
bank), call `decide` with what you chose and why, then act on it.

Your tools:
- look: your hit points, stamina, mana, position, equipment, backpack, how your walk is going, and
  the creatures, corpses and items around you with their serials, each creature with how dangerous a
  fight with it would be for you now (from the game's own numbers). Use it often; it is free.
- command: one game command (the list is below). Answers come back as text. The game commands are
  not tools of their own: `status`, `inv` or `mobiles` go inside `command`.
- wait: let a few seconds pass (walking, fighting, healing take time) and see what happened; it
  ends early when you are hurt.
- decide: note a decision and its reason.
- loot: take what is worth taking from a corpse next to you, most valuable first, as much as you can carry.

Game commands (serials look like 0x0000ABCD; take them from `look` or `mobiles`):
  mobiles [range]             creatures near you, nearest first
  attack <serial>             attack a creature; you keep swinging while it is in reach (1 tile)
  war                         toggle war mode (attacking turns it on)
  goto <x> <y> | goto <place> walk somewhere; it starts the walk and returns at once, `look` shows
                              whether you arrived. Places: `closest <category>` and `findpoi <text>`
                              name them (`goto New Haven Bank`, `goto closest healer`)
  closest <category>          nearest place of a kind: hunt (monsters), animals, bank, healer,
                              provisioner, weaponsmith, armorer, blacksmith, tailor, inn, stables,
                              moongate, dungeon, town
  findpoi <text>              search places by name, or hunting grounds by creature (`findpoi orc`)
  walk <n|s|e|w|ne|nw|se|sw> [run]   one step
  stop                        stop walking
  use <serial>                double-click: a bandage, a potion, a door, a corpse to open it
  target <serial|self>        answer a targeting cursor (after using a bandage: `target self`)
  container <serial>          list what is inside a container or corpse
  get <serial> [amount]       take an item into your backpack
  equip <serial> / unequip <serial>
  inv                         your equipment and backpack
  status / skills             your stats / your skills
  say <text>                  speak (say "bank" next to a banker opens your bank box; "guards"
                              calls the town guards on a criminal or monster attacking you in town)
  shop / buy <serial> <amount>   next to a shopkeeper, `say vendor buy` opens their shop; `shop`
                              lists the stock, `buy` buys. Selling: `say vendor sell`, `selllist`,
                              `sell <serial> <amount>`
  click <serial>              ask a creature's or person's name and title (a shopkeeper's trade)
  drop <item> <container> [amount]
  props <serial>              an item's properties
  canwalk <x> <y> / path <x> <y>
  gumps                       the open gumps (windows the server sent: menus, offers, questions)
  gumpresponse <button> [N ...] answer a gump: the button, plus the [radio N]/[checkbox N] numbers
                              to tick, only if that gump lists any. A wrong answer leaves the gump
                              waiting on the server (a ghost then cannot move: "You are frozen")
  opendoor / dead

Good to know: {world} Healing with a bandage takes several seconds and is interrupted if you are hit hard;
the potion heals at once but has a delay between drinks. {death}"""
# Where a session is played: the open world from New Haven (the default) or a training ground, whose
# data/grounds/<name>.json brings its own texts for these parts.
TOWN = {"start": "You start in New Haven, a guarded town.",
        "goal": """Play however you like for about {minutes} minutes: look around, hunt what you can beat, heal, loot,
restock, bank, explore, get stronger. Nobody tells you what to do; you choose.""",
        "world": """New Haven is on an island (Haven Island), and walking cannot cross water: other
towns and the dungeons are reached through a moongate (`goto New Haven Moongate`; from 1 tile away
`use` the gate and read `gumps`: each destination's name follows its [radio N] line, and
`gumpresponse 1 N` travels there; Felucca's destinations are the 100s)."""}
GROUNDS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "grounds")
DEATH_HEALER = """A dead character becomes a ghost: walk to
a healer's shop (`goto closest healer`) and up to the healer (`mobiles`, `click <serial>` tells who is
who). A healer offers to resurrect you when you come within a few steps: a Resurrection gump, where
`gumpresponse 1` is CONTINUE. No offer? Step a few tiles away and walk back. Your body keeps
your belongings until it decays."""
DEATH_GM = """If you die, you are brought back to life about 30
seconds later next to the nearest town's healer, with little health. Your body stays where you died and
keeps what you were carrying (blessed items stay with you) until it decays."""

TOOLS = [
    {"type": "function", "function": {
        "name": "look", "description": "Your character's state and surroundings: hit points, stamina, mana, position, "
        "status, equipment, backpack, the walk in progress, and nearby creatures, corpses and items with serials.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "command", "description": "Send one game command (see the list in your instructions) and get its answer.",
        "parameters": {"type": "object", "properties": {"command": {"type": "string", "description": "e.g. 'attack 0x00000215'"}},
                       "required": ["command"]}}},
    {"type": "function", "function": {
        "name": "wait", "description": "Let time pass, up to 30 seconds, and get the messages, damage and speech meanwhile; "
        "it ends early when you are hurt.",
        "parameters": {"type": "object", "properties": {"seconds": {"type": "integer", "minimum": 1, "maximum": 30}},
                       "required": ["seconds"]}}},
    {"type": "function", "function": {
        "name": "decide", "description": "Note a decision that matters (where to go, what to fight, run, heal, loot, restock, "
        "bank) and its reason, before acting on it.",
        "parameters": {"type": "object", "properties": {"decision": {"type": "string"}, "reason": {"type": "string"}},
                       "required": ["decision", "reason"]}}},
]
TOOLS.append(LOOT_TOOL)


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def log_size():
    try:
        return os.path.getsize(LOG)
    except OSError:
        return 0


def log_since(offset):
    """The client's log lines written after `offset`, without timestamps, and the new offset."""
    try:
        with open(LOG, "rb") as f:
            f.seek(offset)
            data = f.read()
    except OSError:
        return [], offset
    end = data.rfind(b"\n") + 1
    lines = [STAMP.sub("", l).rstrip() for l in data[:end].decode("utf-8", "replace").split("\n")]
    return [l for l in lines if l], offset + end


def command(text, timeout=12.0, harness=False):
    """Appends one command and returns what the client printed for it, up to its [CMD-END]. The model's
    commands (harness=False) may not use the client-side ones in REFUSED."""
    line = " ".join(text.splitlines()[0].split()) if text.strip() else ""
    line = "".join(c for c in line if c.isprintable())
    if not line:
        return "empty command"
    if not harness and line.split()[0].lower() in REFUSED:
        return f"'{line.split()[0]}' is not available to you"
    named = re.match(r"(?i)^(goto|travel) (.+)$", line)
    spot = named and place(named.group(2))
    if spot:
        # An exact place name: Navrey's own matching takes the nearest place sharing its words instead.
        return command(f"{named.group(1)} {spot[0]} {spot[1]}", timeout)
    found = re.match(r"(?i)^(goto|travel) closest (\w+)$", line)
    if found:
        # What models write for "walk to the nearest bank"; Navrey's `goto <name>` would match names instead.
        nearest = command(f"closest {found.group(2)}", timeout)
        at = re.search(r"at \((\d+), (\d+)", nearest)
        return nearest if not at else nearest + "\n" + command(f"{found.group(1)} {at.group(1)} {at.group(2)}", timeout)
    start = log_size()
    with open(CMD, "a") as f:
        f.write(line + "\n")
    marker, echo, seen, offset = f"[CMD-END] {line} ", f"[CMD] {line}", [], start
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        lines, offset = log_since(offset)
        for text_line in lines:
            if text_line.startswith(marker):
                outcome = text_line[len(marker):]
                body = "\n".join(seen) or "(no output)"
                return body if outcome.startswith("ok") else f"{body}\n{outcome}"
            if text_line != echo:
                seen.append(text_line)
        time.sleep(0.05)
    return "\n".join(seen + [f"(no answer after {timeout:g} s; the client may still be busy)"])


def points():
    """Every place in Navrey's POI files (lab/poi.py's), read once."""
    global PLACES
    if PLACES is None:
        PLACES = [p for path in glob.glob(os.path.join(POI, "*.json")) for cell in read_json(path).get("cells", {}).values() for p in cell]
    return PLACES


def place(name):
    """The (x, y) of the place with exactly this name on the character's facet."""
    facet, wanted = read_json(STATE).get("map"), name.strip().lower()
    return next(((p["x"], p["y"]) for p in points() if p.get("map") == facet and p["name"].lower() == wanted), None)


def nearest(category, facet, x, y, in_town=False):
    """The closest place of a kind on a facet, or None; in_town: only those inside a town (lab/poi.py names
    the others "near <town> ..." or nothing), where the guards are."""
    near = [p for p in points() if p.get("category") == category and p.get("map") == facet
            and (not in_town or not (p["name"].startswith("near ") or p["name"].lower() == category))]
    return min(near, key=lambda p: max(abs(p["x"] - x), abs(p["y"] - y))) if near else None


def direction(dx, dy):
    if not dx and not dy:
        return "here"
    ns = "N" if dy < 0 else "S" if dy > 0 else ""
    ew = "W" if dx < 0 else "E" if dx > 0 else ""
    if abs(dx) > 2 * abs(dy):
        ns = ""
    if abs(dy) > 2 * abs(dx):
        ew = ""
    return ns + ew


def look(deaths=()):
    s, w = read_json(STATE), read_json(WORLD)
    if not s.get("inGame"):
        return "The client is not in the game."
    if time.time() * 1000 - s.get("updatedAtMs", 0) > 10_000:
        return "The client's state is stale; it may have stopped."
    x, y = s["charPosX"], s["charPosY"]
    out = [f"You: {s['charName']} ({s.get('title', '')}), hits {s['hits']}/{s['maxHits']}, stamina {s['stamina']}/{s['maxStam']}, "
           f"mana {s['mana']}/{s['maxMana']}, at ({x}, {y}, {s['charPosZ']}) in {MAPS[s['map']] if s['map'] < len(MAPS) else s['map']} "
           f"facing {s['charDir']}. War mode {'on' if s['warMode'] else 'off'}. Weight {s['weight']}/{s['maxWeight']}. Gold {s['gold']}."]
    flags = [f for f, k in (("GHOST (dead)", "charGhost"), ("poisoned", "isPoisoned"), ("paralyzed", "isParalyzed"),
                            ("hidden", "isHidden"), ("mortally wounded (heals do not work)", "isYellowHits"), ("mounted", "isMounted")) if s.get(k)]
    if flags:
        out.append("Status: " + ", ".join(flags) + ".")
    nav = s.get("nav") or {}
    if nav.get("status") not in (None, "idle"):
        t = nav.get("target") or {}
        where = f" to ({t.get('x')}, {t.get('y')})" if isinstance(t, dict) and "x" in t else ""
        out.append(f"Walk{where}: {nav['status']}" + (f" ({nav['reason']})" if nav.get("reason") else "") + ".")
    a = s.get("lastAttack") or {}
    if a.get("kind") not in (None, "none"):
        out.append("Attacking: " + ", ".join(f"{k} {v}" for k, v in a.items() if k in ("name", "serial", "hits", "maxHits", "x", "y", "exists")))
    eq = [f"{i['name']} ({i['serial']})" for i in s.get("equipped", []) if i.get("layer") not in ("Backpack", "Hair", "Beard", "Bank")]
    out.append("Wearing: " + (", ".join(eq) or "nothing"))
    if s.get("backpackOpened"):
        out.append("Backpack: " + (", ".join(f"{i['name']} ({i['serial']})" for i in s.get("backpack", [])) or "empty"))
    else:
        out.append("Backpack: not opened yet (`command backpack` opens it)")
    mobs = sorted(w.get("mobiles", []), key=lambda m: m.get("distance", 99))
    if mobs:
        out.append("Creatures near you:")
        for m in mobs[:12]:
            kind = f" ({m['species']})" if m.get("species") and m["species"].lower() not in m["name"].lower() else ""
            hp = f"{round(100 * m['hits'] / m['maxHits'])}%" if m.get("maxHits") else "?"
            extra = ", dead" if m.get("isDead") else ", in war mode" if m.get("inWarMode") else ""
            out.append(f"  {m['serial']} {m['name']}{kind}: {m['distance']} tiles {direction(m['x'] - x, m['y'] - y)}, "
                       f"{m.get('notoriety', '?').lower()}, health {hp}{extra}{threat(m, s)}")
    else:
        out.append("No creatures in view.")
    gumps = open_gumps()
    if gumps:
        out.append("Open gumps (answer with gumpresponse): " + "; ".join(gumps))
    near = [c for c in w.get("containers", []) if c.get("distance", 99) <= 12][:6]
    if near:
        out.append("Corpses and containers: " + "; ".join(f"{c['serial']} {c['name']} {c['distance']} tiles" for c in near))
    items = [i for i in w.get("items", []) if i.get("distance", 99) <= 8][:8]
    if items:
        out.append("Items on the ground: " + "; ".join(f"{i['serial']} {i['name']} {i['distance']} tiles" for i in items))
    if deaths:
        out.append(f"You have died {len(deaths)} time(s) this session: " + "; ".join(deaths[-5:]))
    return "\n".join(out)


def open_gumps():
    """The open server gumps, by title and serial; a gump waiting for an answer can block the character."""
    found, lines = [], command("gumps", timeout=5).splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"\[GUMP\] local (0x[0-9A-F]+) server (0x[0-9A-F]+)", line)
        if m:
            title = lines[i + 1].strip() if i + 1 < len(lines) else ""
            found.append(f"{title or 'untitled'} (gump:{m.group(2)})")
    return found


def creature(m):
    """The bestiary's entry for a mobile in view: by its name, else by its body (named orcs and the like)."""
    global BEASTS
    if BEASTS is None:
        beasts = read_json(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "bestiary.json")).values()
        BEASTS = ({c["name"].lower(): c for c in beasts}, {})
        for c in sorted(beasts, key=lambda c: c.get("fame", 0)):
            BEASTS[1].setdefault(int(c.get("body", -1)), c)  # a shared body: the least famous, the commonest
    by_name, by_body = BEASTS
    return by_name.get(m.get("name", "").lower()) or (by_body.get(m.get("graphic")) if not m.get("isHuman") else None)


def threat(m, s):
    """', danger high: a fight would cost about 97% of your health, attacks on sight' from the game's numbers,
    for the warrior-novice template's skills; nothing for people and creatures the bestiary lacks."""
    c = creature(m)
    if not c or not s.get("maxHits"):
        return ""
    d = bestiary.danger(c, dict(FIGHTER, hits=max(1, s.get("hits") or s["maxHits"])))
    temper = "fights back only" if c.get("fightMode") in ("Aggressor", "None") else "attacks on sight"
    caster = ", casts spells" if c.get("ai") == "mage" else ""
    return f", danger {bestiary.level(d['loss'])}: a fight would cost about {round(100 * d['loss'])}% of your health now{caster}, {temper}"


def snapshot():
    """What the character was and saw: kept with each decision."""
    s, w = read_json(STATE), read_json(WORLD)
    me = {k: s.get(k) for k in ("charPosX", "charPosY", "charPosZ", "map", "hits", "maxHits", "stamina", "maxStam", "mana",
                                "maxMana", "warMode", "charGhost", "isPoisoned", "weight", "gold", "nav", "lastAttack")}
    return {"me": me, "mobiles": w.get("mobiles", [])[:15], "containers": w.get("containers", [])[:6]}


def fight(target, tactics, max_seconds, laya, record):
    """Laya fights one creature through Navrey (bot/src/navrey/fight.ts); the answer is how it ended."""
    if not re.fullmatch(r"0x[0-9A-Fa-f]{1,8}", target):
        return f"'{target}' is not a serial (0x0000ABCD, from look or mobiles)"
    if tactics not in ("cautious", "balanced", "aggressive"):
        tactics = "balanced"
    seconds = max(10, min(180, max_seconds))
    done = subprocess.run(["npm", "run", "-s", "nvm", "--", "fight", target, "--tactics", tactics, "--max", str(seconds), "--record", record],
                          cwd=BOT, env=dict(os.environ, LAYA_URL=laya), capture_output=True, text=True, timeout=seconds + 60)
    lines = [l for l in (done.stdout + done.stderr).splitlines() if l.strip()]
    return lines[-1] if lines else f"the fight ended without a word (exit {done.returncode})"


def attackers(s):
    """The creatures in reach that are fighting, the quickest to kill first: who is most likely hitting the
    character (the server tells only the attacker of its own swings). Casters and archers hit from afar."""
    fighting = [m for m in read_json(WORLD).get("mobiles", []) if m.get("inWarMode") and not m.get("isHuman") and not m.get("isPet")
                and not m.get("isDead")]
    near = [m for m in fighting if m.get("distance", 99) <= 1]
    if not near:
        near = [m for m in fighting if m.get("distance", 99) <= 10 and (creature(m) or {}).get("ai") in ("mage", "archer")]
    me = dict(FIGHTER, hits=max(1, s.get("hits") or 1))

    def seconds(m):
        c = creature(m)
        return (bestiary.danger(c, me)["seconds"] if c else 30) * (m.get("hits") or 100) / max(1, m.get("maxHits") or 100)
    return sorted(near, key=seconds)


class Guard(threading.Thread):
    """--laya: an attack outside a fight is answered at once. The model takes seconds a decision and may not
    answer at all: two skeletons killed the character in 35 s while it tried to bandage (2026-10-15). Laya fights
    the attacker, cautious (which retreats when hurt) when the attackers together are dangerous; the model's acting
    commands wait meanwhile, and its next tool result says how the fight went."""

    def __init__(self, player, stop):
        super().__init__(daemon=True)
        self.player, self.stop = player, stop

    def run(self):
        last = read_json(STATE).get("hits")
        while not self.stop.wait(0.5):
            s = read_json(STATE)
            hits, before = s.get("hits"), last
            last = hits
            if s.get("charGhost") or hits is None or before is None or hits >= before:
                continue
            foes = attackers(s)
            if not foes or not self.player.busy.acquire(blocking=False):
                continue  # nobody in reach (poison, a trap) or a fight is on already
            me = dict(FIGHTER, hits=max(1, hits))
            loss = sum(bestiary.danger(c, me)["loss"] for c in map(creature, foes) if c)
            tactics = "cautious" if bestiary.level(loss) in ("high", "deadly") else "balanced"
            foe = foes[0]
            try:
                self.player.reflex = foe["name"]
                result = fight(foe["serial"], tactics, 120, self.player.laya, os.path.join(self.player.folder, "fights.jsonl"))
            finally:
                self.player.reflex = None
                self.player.busy.release()
            others = f" (and {len(foes) - 1} more in reach)" if len(foes) > 1 else ""
            self.player.record(kind="reflex", target=foe["name"], serial=foe["serial"], attackers=len(foes), tactics=tactics,
                               result=result)
            self.player.note(f"{foe['name']} attacked you{others}; Laya fought back, {tactics}: {result}")
            last = read_json(STATE).get("hits")


def snapshots(path_in, path_out, every, stop):
    """Copies a Navrey state file into a .jsonl every `every` seconds until `stop` is set."""
    with open(path_out, "a") as out:
        while not stop.is_set():
            data = read_json(path_in)
            if data:
                out.write(json.dumps({"t": time.time(), "state": data}) + "\n")
                out.flush()
            stop.wait(every)


class Player:
    def __init__(self, folder, laya=None):
        self.folder = folder
        self.laya = laya
        self.log_offset = log_size()
        self.events = open(os.path.join(folder, "agent.jsonl"), "a")
        self.lock = threading.Lock()
        self.decisions = open(os.path.join(folder, "decisions.jsonl"), "a")
        self.counts = {"command": 0, "look": 0, "wait": 0, "decide": 0, **({"fight": 0} if laya else {})}
        # Where the character died and what stood around it: a model sent back to the same spot four times
        # running (2026-10-13) had it in its history but not in front of it.
        self.deaths, self.ghost = [], bool(read_json(STATE).get("charGhost"))
        # One fight at a time, the model's or the Guard's; what the Guard did waits in notes for the next tool result.
        self.busy, self.notes, self.reflex = threading.Lock(), [], None

    def note(self, text):
        with self.lock:
            self.notes.append(text)

    def take_notes(self):
        with self.lock:
            notes, self.notes = self.notes, []
        return notes

    def record(self, **event):
        with self.lock:
            self.events.write(json.dumps({"t": time.time(), **event}) + "\n")
            self.events.flush()

    def call(self, name, args):
        """Runs a tool for the model and records it."""
        args = args if isinstance(args, dict) else {}
        started = time.time()
        try:
            result = self.run_tool(str(name), args)[:4000]
        except Exception as e:  # a harness bug must not end the session: the model sees it and goes on
            result = f"the tool failed: {type(e).__name__}: {e}"
        notes = self.take_notes()
        if notes:
            result = "\n".join(f"(While you were deciding: {n})" for n in notes) + "\n" + result
        self.counts[name] = self.counts.get(name, 0) + 1
        self.record(kind="tool", name=name, args=args, result=result, ms=round(1000 * (time.time() - started)))
        return result

    def note_death(self):
        s = read_json(STATE)
        ghost = bool(s.get("charGhost"))
        if ghost and not self.ghost:
            near = sorted((m for m in read_json(WORLD).get("mobiles", []) if m.get("notoriety") in ("Criminal", "Murderer", "Enemy", "Gray")
                           and m.get("distance", 99) <= 4), key=lambda m: m.get("distance", 99))
            names = sorted({m["name"] for m in near[:3]})
            self.deaths.append(f"at ({s.get('charPosX')}, {s.get('charPosY')}) on {time.strftime('%H:%M')}"
                               + (f", with {' and '.join(names)} next to you" if names else ""))
        self.ghost = ghost

    def run_tool(self, name, args):
        self.note_death()
        if name == "look":
            fighting = f"\nLaya is fighting {self.reflex} for you: it attacked you." if self.reflex else ""
            return look(self.deaths) + fighting
        if name == "command":
            text = str(args.get("command", ""))
            if self.laya and text.split() and text.split()[0].lower() in ACTS:
                return self.act(lambda: command(text))
            return command(text)
        if name == "wait":
            seconds = max(1, min(30, int(args.get("seconds") or 5)))
            # The wait ends early when the character is hurt or dies: a model waiting out a walk into a
            # graveyard was killed before it could answer (2026-10-13).
            # A ghost waits on (until the reviver or a healer); anyone else wakes at the first damage or death.
            first = read_json(STATE)
            start, ghost, hurt, raised = first.get("hits"), bool(first.get("charGhost")), False, False
            for _ in range(seconds * 2):
                time.sleep(0.5)
                s = read_json(STATE)
                if ghost and s.get("charGhost") is False:
                    raised = True
                    break
                if not ghost and (s.get("charGhost") or (start is not None and s.get("hits", start) < start)):
                    hurt = True
                    break
            if hurt and self.laya:
                time.sleep(1.5)  # the Guard looks every half second: let it take the fight, then wait it out
                with self.busy:
                    pass
            lines, self.log_offset = log_since(self.log_offset)
            # Navrey narrates itself too (command replies, which the model has had already, labels, gump dumps
            # `gumps` repeats): what the game said is what matters.
            said, replying = [], False
            for l in lines:
                if l.startswith(("[CMD] ", "[CMD-END] ")):
                    replying = l.startswith("[CMD] ")
                elif not replying and not l.startswith(("[LABEL]", "[PERF]", "[DEBUG", "[GUMP]", "  ")):
                    said.append(l)
            lines = said
            text = "\n".join(lines[-40:]) or f"{seconds} s passed quietly."
            return text + ("\n(The wait ended early: you are being hurt.)" if hurt else "\n(You are alive again.)" if raised else "")
        if name == "loot":
            return self.act(lambda: take_loot(str(args.get("container", ""))))
        if name == "fight" and self.laya:
            return self.act(lambda: fight(str(args.get("target", "")), str(args.get("tactics") or "balanced"),
                                          int(args.get("max_seconds") or 120), self.laya, os.path.join(self.folder, "fights.jsonl")))
        if name == "decide":
            entry = {"t": time.time(), "decision": str(args.get("decision", "")), "reason": str(args.get("reason", "")), **snapshot()}
            self.decisions.write(json.dumps(entry) + "\n")
            self.decisions.flush()
            return "noted"
        if name.lower() in COMMANDS:
            # A command called as a tool of its own (`mobiles` with {"range": 10}): run it as one.
            return command(" ".join([name.lower()] + [str(v) for v in args.values()]))
        return f"unknown tool {name}; your tools are look, command, wait and decide"

    def act(self, do):
        """An action of the model's, after any fight the Guard is in; not done when one came in between, since the
        model chose it without knowing."""
        with self.busy:
            with self.lock:
                changed = bool(self.notes)
            return "Not done: Laya fought for you meanwhile (above). Send it again if you still want it." if changed else do()


def ask(base, model, messages, tools, timeout=600):
    body = json.dumps({"model": model, "messages": messages, "tools": tools, "temperature": 0.7}).encode()
    req = urllib.request.Request(f"{base}/chat/completions", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def trimmed(system, turns, start):
    """The instructions and the turns from `start` on (a turn is a model reply with its tool results), and the
    new start. Past HISTORY_CHARS the oldest turns go until half of it is left, all at once: the server keeps
    the prompt it has seen (Ollama's cache), and trimming a turn per call changed its beginning every time. In a
    30-minute session that took replies from 0.8 s to 15 s once the history was full."""
    size = sum(len(json.dumps(m)) for turn in turns[start:] for m in turn)
    if size > HISTORY_CHARS:
        while start < len(turns) - 1 and size > HISTORY_CHARS // 2:
            size -= sum(len(json.dumps(m)) for m in turns[start])
            start += 1
    return [system] + [m for turn in turns[start:] for m in turn], start


def gm(*commands, wait=3, timeout=300):
    """GM commands on the world server (lab/world.sh gm): its exit code and what the server answered. Each
    command waits for the server's answer, at most `wait` seconds."""
    done = subprocess.run(["bash", WORLD_SH, "gm", "--wait", str(wait), "--settle", "400", *commands], capture_output=True, text=True,
                          timeout=timeout)
    return done.returncode, done.stdout + done.stderr


def load_ground(name):
    """A training ground (data/grounds/<name>.json): where its creatures live, its start and its texts."""
    with open(os.path.join(GROUNDS, f"{name}.json")) as f:
        ground = json.load(f)
    ground["name"] = name
    # NeoPlace puts a player on the arena's centre row, at most 9 tiles west of the centre.
    if ground["start"][1] != 0 or not -9 <= ground["start"][0] < 0:
        raise ValueError(f"{name}: the start must be on the centre row, 1 to 9 tiles west of the centre")
    return ground


def to_start(name, ground):
    """GM commands that bring the character to the ground's start, alive, at full health and refitted."""
    return [f"[NeoPlace {name} west {-2 * ground['start'][0]}", f"[NeoTemplate {name} warrior-novice"]


class Reviver(threading.Thread):
    """--revive gm: 30 s after a death the GM brings the character back, its body left where it fell: next to the
    nearest town's healer with a resurrection's low health, or on a training ground at its start, refitted. A ghost
    that had to find a healer itself spent 25 of a session's 30 minutes at it (2026-10-13), which is not what the
    sessions are there to measure."""

    def __init__(self, name, player, stop, ground=None, delay=30):
        super().__init__(daemon=True)
        self.name, self.player, self.stop, self.ground, self.delay = name, player, stop, ground, delay

    def run(self):
        died_at = None
        while not self.stop.wait(2):
            s = read_json(STATE)
            if not s.get("charGhost"):
                died_at = None
                continue
            died_at = died_at or time.time()
            if time.time() - died_at < self.delay:
                continue
            x, y, facet = s.get("charPosX"), s.get("charPosY"), s.get("map")
            if self.ground:
                # The server brings the character back ([NeoGround]); only if it did not, the GM does.
                for _ in range(30):
                    if not read_json(STATE).get("charGhost") or self.stop.wait(2):
                        break
                code = 0 if not read_json(STATE).get("charGhost") else gm(*to_start(self.name, self.ground))[0]
                self.player.record(kind="revive", died=[x, y, facet], at=f"start of {self.ground['name']}", ok=code == 0)
                time.sleep(2)
                self.player.record(kind="plan", sent=apply_plan(every=True))  # the refit gave back the template's skills
            else:
                # A town's healer, in the guards' reach: Old Haven's healer stands among its undead (2026-10-15).
                healer = nearest("healer", facet, x, y, in_town=True) or nearest("healer", facet, x, y)
                who = f"where PlayerMobile Name = {self.name}"
                commands = [f"[Global Res {who}"]
                if healer:
                    commands.append(f'[Global Set Location "({healer["x"]}, {healer["y"]}, {healer.get("z", 0)})" {who}')
                code, _ = gm(*commands, timeout=180)
                self.player.record(kind="revive", died=[x, y, facet], healer=healer and healer["name"], ok=code == 0)
            died_at = None  # still a ghost at the next look: another try after the delay


def take_loot(serial):
    """A corpse looted by value (lab/loot.py): opened, listed, and its items taken in order, one lift a second
    (the server's own delay between lifts), until the weight limit."""
    if not re.fullmatch(r"0x[0-9A-Fa-f]{1,8}", serial):
        return f"'{serial}' is not a serial (0x4004C7AF, from look)"
    opened = command(f"use {serial}")
    if re.search(r"too far|cannot reach|not in range|out of range", opened, re.I):
        return f"{opened}\nWalk next to it first."
    # The corpse's contents arrive a moment after the use: wait for them (Navrey says "not opened yet" until then).
    for _ in range(8):
        time.sleep(0.4)
        listing = command(f"container {serial}")
        if "not opened yet" not in listing:
            break
    else:
        return f"could not open {serial} (is it within 2 tiles?):\n{opened.strip()[-200:]}"
    weights = loot.status_weight(command("status"))
    if not weights:
        return "could not read your weight from `status`"
    order = loot.plan(listing, *weights)
    if not order:
        return f"nothing worth taking in {serial}:\n{listing[-600:]}"
    took = []
    for item, amount, why in order:
        reply = command(f"get {item} {amount}")
        took.append(f"{amount} x {why.split(':')[0]}" + ("" if re.search(r"grabbed|ok\b", reply, re.I) or not reply.strip() else f" ({reply.strip()[:80]})"))
        time.sleep(loot.LIFT_INTERVAL)
    return "Took, most valuable first: " + "; ".join(took)


def apply_plan(template="warrior-novice", every=False):
    """The character's skill and stat locks set as its template's plan says (lab/skillplan.py): planned skills up
    until reached, then locked; the rest down, so that what a fight trains by the way gives its points back at the
    cap. every: the skills at 0 too (after a refit their locks are unknown). Returns the commands it sent."""
    plan = skillplan.plan_of(template)
    if not plan:
        return []
    now = skillplan.parse_skills(command("skills", harness=True).splitlines())
    state = read_json(STATE)
    stats = {k: state.get(k) for k in ("str", "dex", "int")}
    locks = {k: state.get(f"{k}Lock") or "" for k in ("str", "dex", "int")}
    sent = []
    for line in skillplan.commands(now, skillplan.skill_locks(plan, now, every), locks, skillplan.stat_locks(plan, stats)):
        if "unknown command" in command(line, harness=True):
            return sent + [f"({line.split()[0]} is not in this client yet)"]
        sent.append(line)
    return sent


class Planner(threading.Thread):
    """Every 5 minutes the locks are set again as the plan says: a skill that reached its target gets locked."""

    def __init__(self, player, stop, every=300):
        super().__init__(daemon=True)
        self.player, self.stop, self.every = player, stop, every

    def run(self):
        while not self.stop.wait(self.every):
            sent = apply_plan()
            if sent:
                self.player.record(kind="plan", sent=sent)


def fresh_start(name):
    """The character alive, refitted and at New Haven's centre, so that sessions can be compared."""
    who = f"where PlayerMobile Name = {name}"
    code, out = gm(f'[Global Set Location "(3503, 2574, 14)" {who}', f"[Global Set Map Trammel {who}", f"[NeoPrep {name}",
                   f"[NeoTemplate {name} warrior-novice", wait=5)
    time.sleep(3)
    s = read_json(STATE)
    if code or s.get("charGhost") or (s.get("charPosX"), s.get("charPosY")) != (3503, 2574):
        sys.exit(f"could not set {name} up in New Haven: {out.strip()[-400:]}")


def ground_start(name, ground):
    """A fresh training ground, kept by the server ([NeoGround]: its spawners, strangers out, the character back at
    the start after a death), and the character refitted at the start, so that sessions on it can be compared."""
    code, out = gm(f"[NeoGround {ground['name']} {name}", *to_start(name, ground), wait=5)
    if "NEO ground" not in out:
        sys.exit(f"the world server cannot keep grounds (scripts/server-image.sh pull, lab/world.sh start): {out.strip()[-300:]}")
    time.sleep(3)
    s = read_json(STATE)
    start = (ground["center"][0] + ground["start"][0], ground["center"][1] + ground["start"][1])
    if code or s.get("charGhost") or (s.get("charPosX"), s.get("charPosY")) != start:
        sys.exit(f"could not set {name} up on the ground {ground['name']}: {out.strip()[-400:]}")


def play_openai(base, model, system, player, deadline):
    """The loop for a model behind an OpenAI-compatible endpoint."""
    tools = TOOLS + ([FIGHT_TOOL] if player.laya else [])
    system = {"role": "system", "content": system}
    turns = [[{"role": "user", "content": FIRST}]]
    failures, replies, start = 0, 0, 0
    while time.time() < deadline:
        started = time.time()
        messages, start = trimmed(system, turns, start)
        try:
            answer = ask(base, model, messages, tools)
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            failures += 1
            player.record(kind="error", error=str(e))
            if failures >= 5:
                print(f"{time.strftime('%H:%M')} the model failed 5 times in a row: {e}", flush=True)
                break
            if isinstance(e, urllib.error.HTTPError) and e.code == 500:
                # Ollama answers 500 when the model's reply cannot be read: gpt-oss called game commands (status,
                # inv, container) as tools of their own and repeated it on every retry of the same conversation,
                # ending three night sessions in minutes (2026-10-16). Say so instead of asking the same again.
                turns.append([{"role": "user", "content": REREAD}])
            time.sleep(10)
            continue
        failures = 0
        replies += 1
        msg = answer["choices"][0]["message"]
        calls = msg.get("tool_calls") or []
        reply = {"role": "assistant", "content": msg.get("content") or ""}
        if calls:
            reply["tool_calls"] = calls
        player.record(kind="model", ms=round(1000 * (time.time() - started)), content=reply["content"],
                      reasoning=msg.get("reasoning") or msg.get("reasoning_content"), tool_calls=calls, usage=answer.get("usage"))
        turn = [reply]
        for call in calls:
            name = call["function"]["name"]
            try:
                call_args = json.loads(call["function"].get("arguments") or "{}")
            except ValueError:
                call_args = {}
            turn.append({"role": "tool", "tool_call_id": call.get("id", name), "name": name, "content": player.call(name, call_args)})
        if not calls:
            left = max(0, round((deadline - time.time()) / 60))
            turn.append({"role": "user", "content": f"Keep playing; about {left} minutes are left. Use your tools."})
        turns.append(turn)
    print(f"{time.strftime('%H:%M')} {replies} replies; " + ", ".join(f"{k} {v}" for k, v in player.counts.items()), flush=True)


def serve(folder, laya=None):
    """The tools as an MCP server on stdin/stdout (JSON-RPC, one message per line), for Claude Code."""
    player = Player(folder, laya)
    if laya:
        Guard(player, threading.Event()).start()  # the server lives as long as Claude Code's session
    tools = [{"name": t["function"]["name"], "description": t["function"]["description"], "inputSchema": t["function"]["parameters"]}
             for t in TOOLS + ([FIGHT_TOOL] if laya else [])]
    for raw in sys.stdin:
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        if "id" not in msg:
            continue  # a notification
        method, params = msg.get("method"), msg.get("params") or {}
        reply = {"jsonrpc": "2.0", "id": msg["id"]}
        if method == "initialize":
            reply["result"] = {"protocolVersion": params.get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                               "serverInfo": {"name": "uo", "version": "1"}}
        elif method == "tools/list":
            reply["result"] = {"tools": tools}
        elif method == "tools/call":
            text = player.call(params.get("name"), params.get("arguments") or {})
            reply["result"] = {"content": [{"type": "text", "text": text}], "isError": False}
        elif method == "ping":
            reply["result"] = {}
        else:
            reply["error"] = {"code": -32601, "message": f"unknown method {method}"}
        print(json.dumps(reply), flush=True)


def play_claude(model, system, folder, deadline, laya=None):
    """Claude Code with no tools of its own and ours over MCP; resumed with a nudge whenever it stops early."""
    config = os.path.join(folder, "mcp.json")
    serve_args = [os.path.abspath(__file__), "--serve", folder] + (["--laya", laya] if laya else [])
    with open(config, "w") as f:
        json.dump({"mcpServers": {"uo": {"command": sys.executable, "args": serve_args}}}, f)
    allowed = ",".join(f"mcp__uo__{t['function']['name']}" for t in TOOLS + ([FIGHT_TOOL] if laya else []))
    prompt, session, rounds = FIRST, None, 0
    with open(os.path.join(folder, "claude.jsonl"), "a") as out:
        while time.time() < deadline - 30:
            cmd = ["claude", "-p", prompt, "--model", model, "--system-prompt", system, "--tools", "", "--mcp-config", config,
                   "--strict-mcp-config", "--allowedTools", allowed, "--permission-prompts", "none",
                   "--output-format", "stream-json", "--verbose"] + (["--resume", session] if session else [])
            # Started in the session folder, so that no project's CLAUDE.md or settings come along.
            proc = subprocess.Popen(cmd, cwd=folder, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, start_new_session=True)
            timer = threading.Timer(max(1.0, deadline - time.time()), lambda: os.killpg(proc.pid, signal.SIGTERM))
            timer.start()
            for line in proc.stdout:
                out.write(line)
                out.flush()
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get("type") == "system" and event.get("subtype") == "init":
                    session = event.get("session_id") or session
            proc.wait()
            timer.cancel()
            rounds += 1
            if not session:
                print(f"{time.strftime('%H:%M')} Claude Code did not start (exit {proc.returncode}); see claude.jsonl", flush=True)
                break
            prompt = f"Keep playing; about {max(0, round((deadline - time.time()) / 60))} minutes are left. Use your tools."
    print(f"{time.strftime('%H:%M')} Claude Code ran {rounds} time(s)", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("player", nargs="?", help="a name for the run (gemma, qwen, fable, ...)")
    ap.add_argument("--model", help="the model's name at an OpenAI-compatible endpoint (gemma4-32k)")
    ap.add_argument("--base", default="http://localhost:11434/v1", help="the endpoint (default: Ollama)")
    ap.add_argument("--claude", metavar="MODEL", help="a Claude model, played through Claude Code (claude-fable-5-1)")
    ap.add_argument("--minutes", type=float, default=30)
    ap.add_argument("--name", default=None, help="the character's name (default: the player's, capitalised)")
    ap.add_argument("--as-is", action="store_true", help="play on from where the character is, as it is")
    ap.add_argument("--revive", choices=["gm", "healer"], default="gm",
                    help="after a death: the GM revives the character at the nearest healer 30 s later (gm), or it walks to one as a ghost")
    ap.add_argument("--laya", metavar="URL", help="a Laya server: the model gets `fight`, and Laya makes every move of a fight")
    ap.add_argument("--ground", metavar="NAME", help="play on a training ground (data/grounds/NAME.json) instead of the open world")
    ap.add_argument("--video", type=float, default=2, metavar="FPS",
                    help="record the game's own frames at FPS into session.mp4 (Navrey's record command; 0: no video)")
    ap.add_argument("--serve", metavar="FOLDER", help=argparse.SUPPRESS)  # the MCP server Claude Code starts
    args = ap.parse_args()
    if args.serve:
        return serve(args.serve, args.laya)
    if not args.player or bool(args.model) == bool(args.claude):
        ap.error("a player name and either --model or --claude")

    ground = load_ground(args.ground) if args.ground else None
    if ground and args.revive != "gm":
        ap.error("a training ground has no healer: --revive gm")
    name = args.name or args.player.capitalize()
    if not args.as_is:
        if ground:
            ground_start(name, ground)
        else:
            fresh_start(name)
    planned = apply_plan(every=True)  # skill and stat locks as the template's plan says
    folder = os.path.join(SESSIONS, f"{time.strftime('%Y-%m-%dT%H-%M')}-{args.player}")
    os.makedirs(folder, exist_ok=True)
    place = ground["prompt"] if ground else dict(TOWN, death=DEATH_GM if args.revive == "gm" else DEATH_HEALER)
    system = SYSTEM.format(name=name, start=place["start"], goal=place["goal"].format(minutes=int(args.minutes)), world=place["world"],
                           death=place["death"]) + (FIGHT if args.laya else "")
    with open(os.path.join(folder, "run.json"), "w") as f:
        json.dump({"player": args.player, "model": args.claude or args.model, "base": None if args.claude else args.base,
                   "character": name, "fresh": not args.as_is, "ground": args.ground, "revive": args.revive, "plan": planned, "minutes": args.minutes, "laya": args.laya, "started": time.time(), "harness": "lab/uo_agent.py", "system": system, "tools": TOOLS},
                  f, indent=1)

    stop = threading.Event()
    threads = [threading.Thread(target=snapshots, args=(STATE, os.path.join(folder, "state.jsonl"), 2, stop), daemon=True),
               threading.Thread(target=snapshots, args=(WORLD, os.path.join(folder, "world.jsonl"), 5, stop), daemon=True)]
    if args.revive == "gm":
        threads.append(Reviver(name, Player(folder), stop, ground))
    threads.append(Planner(Player(folder), stop))
    player = None if args.claude else Player(folder, args.laya)  # Claude Code's tools run in their own server (--serve)
    if player and args.laya:
        threads.append(Guard(player, stop))
    for t in threads:
        t.start()
    log_start = log_size()
    if args.video:
        # Video time = event time - this start: video.json lets the recording be read against the logs.
        # Navrey reads its own frames and pipes them into ffmpeg: session.mp4, no frames on disk.
        print(command(f"record {os.path.join(folder, 'session.mp4')} {args.video:g}", harness=True), flush=True)
        with open(os.path.join(folder, "video.json"), "w") as f:
            json.dump({"started": time.time(), "fps": args.video}, f)
    deadline = time.time() + args.minutes * 60
    print(f"{time.strftime('%H:%M')} {args.player} ({args.claude or args.model}) plays for {args.minutes:g} min; recording into {folder}",
          flush=True)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        if args.claude:
            play_claude(args.claude, system, folder, deadline, args.laya)
        else:
            play_openai(args.base, args.model, system, player, deadline)
    except KeyboardInterrupt:
        print(f"{time.strftime('%H:%M')} stopped early", flush=True)
    stop.set()
    if args.video:
        print(command("record stop", harness=True, timeout=120), flush=True)
    for t in threads:
        t.join(timeout=10)
    if os.path.exists(LOG):
        with open(LOG, "rb") as f, open(os.path.join(folder, "cuolog.txt"), "wb") as out:
            f.seek(log_start)
            shutil.copyfileobj(f, out)
    decisions = sum(1 for _ in open(os.path.join(folder, "decisions.jsonl"))) if os.path.exists(os.path.join(folder, "decisions.jsonl")) else 0
    print(f"{time.strftime('%H:%M')} {args.player} done: {decisions} decisions; {folder}", flush=True)


if __name__ == "__main__":
    main()
