#!/usr/bin/env python3
"""A model plays Ultima Online through Navrey with game tools only, and every step is recorded:

    python3 lab/uo_agent.py gemma --model gemma4-32k --minutes 30
    python3 lab/uo_agent.py qwen --model qwen3.8:27b --minutes 30
    python3 lab/uo_agent.py fable --claude claude-fable-5-1 --minutes 30
    python3 lab/uo_agent.py gemma-laya --name Gemma --model gemma4-32k --laya http://127.0.0.1:8100

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
(lab/world.sh gm). Any OpenAI-compatible endpoint with tool calls serves (Ollama by default). A Claude model plays
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

CMD, LOG = "/tmp/cuocmd", "/tmp/cuolog"
STATE, WORLD = "/tmp/cuostate.json", "/tmp/cuoworld.json"
STAMP = re.compile(r"^\[\d{2}:\d{2}:\d{2}\.\d{3}\] ")
# Client-side commands that are not play: the window (the person watching keeps it) and the log level
# (the replies are read from the log).
REFUSED = {"hide", "show", "quiet", "q", "verbose"}
MAPS = ["Felucca", "Trammel", "Ilshenar", "Malas", "Tokuno", "Ter Mur"]
COMMANDS = {"mobiles", "attack", "war", "goto", "gotoexact", "travel", "closest", "findpoi", "walk", "stop", "use", "target",
            "container", "get", "equip", "unequip", "inv", "status", "skills", "say", "shop", "buy", "sell", "selllist", "click",
            "drop", "props", "canwalk", "path", "opendoor", "dead", "gumps", "gumpresponse", "items", "nearest", "attacknearest",
            "backpack", "hp", "los", "useskill", "cast", "dropground", "mount", "dismount", "pos"}
HISTORY_CHARS = 60_000  # the most conversation kept beyond the instructions, about 17k tokens
SESSIONS = os.path.expanduser("~/UO/sessions")
POI = os.path.expanduser("~/UO/poi")  # lab/poi.py's output, the folder Navrey's settings.json names
PLACES = None
FIRST = "You are in the game now. Begin: look around and decide what to do."
BOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bot")
FIGHT = """

Fights: you have fast fighting reflexes, Laya, a small model that decides every move of a fight in
a few hundredths of a second. `fight` hands it one creature: you choose what to fight, when, and how
carefully (tactics: cautious heals early and may run when hurt; balanced; aggressive fights on), and
Laya fights until the creature dies, you die, you get away or it goes out of view, then tells you
how it went. Use `fight` rather than `attack` for anything that fights back."""
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
bandages, three greater heal potions and 1,000 gold. You start in New Haven, a guarded town.

Play however you like for about {minutes} minutes: look around, hunt what you can beat, heal, loot,
restock, bank, explore, get stronger. Nobody tells you what to do; you choose.

Before every decision that matters (where to go, what to fight, when to run, heal, loot, restock or
bank), call `decide` with what you chose and why, then act on it.

Your tools:
- look: your hit points, stamina, mana, position, equipment, backpack, how your walk is going, and
  the creatures, corpses and items around you with their serials. Use it often; it is free.
- command: one game command (the list is below). Answers come back as text.
- wait: let a few seconds pass (walking, fighting, healing take time) and see what happened.
- decide: note a decision and its reason.

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

Good to know: New Haven is on an island (Haven Island), and walking cannot cross water: other
towns and the dungeons are reached through a moongate (`goto New Haven Moongate`; from 1 tile away
`use` the gate and read `gumps`: each destination's name follows its [radio N] line, and
`gumpresponse 1 N` travels there; Felucca's destinations are the 100s). Healing with a bandage takes several seconds and is interrupted if you are hit hard;
the potion heals at once but has a delay between drinks. A dead character becomes a ghost: walk to
a healer's shop (`goto closest healer`) and up to the healer (`mobiles`, `click <serial>` tells who is
who). A healer offers to resurrect you when you come within a few steps: a Resurrection gump, where
`gumpresponse 1` is CONTINUE. No offer? Step a few tiles away and walk back. Your body keeps
your belongings until it decays."""

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
        "name": "wait", "description": "Let time pass, up to 30 seconds, and get the messages, damage and speech meanwhile.",
        "parameters": {"type": "object", "properties": {"seconds": {"type": "integer", "minimum": 1, "maximum": 30}},
                       "required": ["seconds"]}}},
    {"type": "function", "function": {
        "name": "decide", "description": "Note a decision that matters (where to go, what to fight, run, heal, loot, restock, "
        "bank) and its reason, before acting on it.",
        "parameters": {"type": "object", "properties": {"decision": {"type": "string"}, "reason": {"type": "string"}},
                       "required": ["decision", "reason"]}}},
]


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


def command(text, timeout=12.0):
    """Appends one command and returns what the client printed for it, up to its [CMD-END]."""
    line = " ".join(text.splitlines()[0].split()) if text.strip() else ""
    line = "".join(c for c in line if c.isprintable())
    if not line:
        return "empty command"
    if line.split()[0].lower() in REFUSED:
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


def place(name):
    """The (x, y) of the place with exactly this name on the character's facet, from Navrey's POI files."""
    global PLACES
    if PLACES is None:
        PLACES = {}
        for path in glob.glob(os.path.join(POI, "*.json")):
            for cell in read_json(path).get("cells", {}).values():
                for p in cell:
                    PLACES.setdefault((p["name"].lower(), p.get("map")), (p["x"], p["y"]))
    return PLACES.get((name.strip().lower(), read_json(STATE).get("map")))


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


def look():
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
                       f"{m.get('notoriety', '?').lower()}, health {hp}{extra}")
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
        self.decisions = open(os.path.join(folder, "decisions.jsonl"), "a")
        self.counts = {"command": 0, "look": 0, "wait": 0, "decide": 0, **({"fight": 0} if laya else {})}

    def record(self, **event):
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
        self.counts[name] = self.counts.get(name, 0) + 1
        self.record(kind="tool", name=name, args=args, result=result, ms=round(1000 * (time.time() - started)))
        return result

    def run_tool(self, name, args):
        if name == "look":
            return look()
        if name == "command":
            return command(str(args.get("command", "")))
        if name == "wait":
            seconds = max(1, min(30, int(args.get("seconds") or 5)))
            time.sleep(seconds)
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
            return "\n".join(lines[-40:]) or f"{seconds} s passed quietly."
        if name == "fight" and self.laya:
            return fight(str(args.get("target", "")), str(args.get("tactics") or "balanced"), int(args.get("max_seconds") or 120),
                         self.laya, os.path.join(self.folder, "fights.jsonl"))
        if name == "decide":
            entry = {"t": time.time(), "decision": str(args.get("decision", "")), "reason": str(args.get("reason", "")), **snapshot()}
            self.decisions.write(json.dumps(entry) + "\n")
            self.decisions.flush()
            return "noted"
        if name.lower() in COMMANDS:
            # A command called as a tool of its own (`mobiles` with {"range": 10}): run it as one.
            return command(" ".join([name.lower()] + [str(v) for v in args.values()]))
        return f"unknown tool {name}; your tools are look, command, wait and decide"


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


def fresh_start(name):
    """The character alive, refitted and at New Haven's centre, so that sessions can be compared."""
    who = f"where PlayerMobile Name = {name}"
    commands = [f'[Global Set Location "(3503, 2574, 14)" {who}', f"[Global Set Map Trammel {who}", f"[NeoPrep {name}",
                f"[NeoTemplate {name} warrior-novice"]
    done = subprocess.run(["bash", os.path.join(os.path.dirname(os.path.abspath(__file__)), "world.sh"), "gm", "--wait", "5", *commands],
                          capture_output=True, text=True, timeout=300)
    time.sleep(3)
    s = read_json(STATE)
    if done.returncode or s.get("charGhost") or (s.get("charPosX"), s.get("charPosY")) != (3503, 2574):
        sys.exit(f"could not set {name} up in New Haven: {(done.stdout + done.stderr).strip()[-400:]}")


def play_openai(base, model, system, folder, deadline, laya=None):
    """The loop for a model behind an OpenAI-compatible endpoint."""
    player = Player(folder, laya)
    tools = TOOLS + ([FIGHT_TOOL] if laya else [])
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
    ap.add_argument("--laya", metavar="URL", help="a Laya server: the model gets `fight`, and Laya makes every move of a fight")
    ap.add_argument("--serve", metavar="FOLDER", help=argparse.SUPPRESS)  # the MCP server Claude Code starts
    args = ap.parse_args()
    if args.serve:
        return serve(args.serve, args.laya)
    if not args.player or bool(args.model) == bool(args.claude):
        ap.error("a player name and either --model or --claude")

    name = args.name or args.player.capitalize()
    if not args.as_is:
        fresh_start(name)
    folder = os.path.join(SESSIONS, f"{time.strftime('%Y-%m-%dT%H-%M')}-{args.player}")
    os.makedirs(folder, exist_ok=True)
    system = SYSTEM.format(name=name, minutes=int(args.minutes)) + (FIGHT if args.laya else "")
    with open(os.path.join(folder, "run.json"), "w") as f:
        json.dump({"player": args.player, "model": args.claude or args.model, "base": None if args.claude else args.base,
                   "character": name, "fresh": not args.as_is, "minutes": args.minutes, "laya": args.laya, "started": time.time(), "harness": "lab/uo_agent.py", "system": system, "tools": TOOLS},
                  f, indent=1)

    stop = threading.Event()
    threads = [threading.Thread(target=snapshots, args=(STATE, os.path.join(folder, "state.jsonl"), 2, stop), daemon=True),
               threading.Thread(target=snapshots, args=(WORLD, os.path.join(folder, "world.jsonl"), 5, stop), daemon=True)]
    for t in threads:
        t.start()
    log_start = log_size()
    deadline = time.time() + args.minutes * 60
    print(f"{time.strftime('%H:%M')} {args.player} ({args.claude or args.model}) plays for {args.minutes:g} min; recording into {folder}",
          flush=True)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        if args.claude:
            play_claude(args.claude, system, folder, deadline, args.laya)
        else:
            play_openai(args.base, args.model, system, folder, deadline, args.laya)
    except KeyboardInterrupt:
        print(f"{time.strftime('%H:%M')} stopped early", flush=True)
    stop.set()
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
