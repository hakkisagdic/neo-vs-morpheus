#!/usr/bin/env python3
"""Looting by value: which of a corpse's items to take, in what order, within what the character can carry.

    import loot
    listing = command("container 0x4004F3E7")              # what Navrey prints for the corpse
    for serial, amount, why in loot.plan(listing, weight=60, max_weight=345):
        command(f"get {serial} {amount}")                   # one lift at a time, loot.LIFT_INTERVAL apart

    python3 lab/loot.py listing.txt 60 345                  # the same from a file, for a look

Pure functions, no game access. The order: first what data/valuables.json lists (gold, gems, treasure maps,
artifacts, spell scrolls, magic items), in that list's order; then everything vendors pay for, by gold per
stone; last the items whose value nobody knows, and of those only the light ones. Prices and weights come
from data/items.json (lab/itemvalues.py, read from ModernUO's source). Navrey's listing gives each item's
name, not its graphic, so items are known by name (`identify`); a caller that knows graphics or tooltips
passes them too. A stack is taken in part when only part of it fits.

Weight is what the client's status shows (`Weight: 60/345`): the body's 11 stones and the backpack's 3 with
everything carried, against the maximum. ModernUO warns when the total passes the maximum and charges
stamina for every step more than 4 stones above it (StaminaSystem), so the plan stops at the maximum.
A stack's weight is its pieces' weight rounded up, as the server counts it (Item.PileWeight).

The pace is the server's: ModernUO lets a character lift one item per action delay, 1 second in the
Age of Shadows and later eras (Mobile.ActionDelay, ExpansionConfiguration's actionDelay), and refuses a
lift sooner ("You must wait to perform another action"). Hence LIFT_INTERVAL; nothing here waits.
"""
import json
import math
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ITEMS = os.path.join(ROOT, "data", "items.json")
VALUABLES = os.path.join(ROOT, "data", "valuables.json")

LIFT_INTERVAL = 1.0   # seconds between lifts: ModernUO's action delay in our era (ML)
LIGHT = 2.0           # stones: an item of unknown value is taken when its whole stack weighs no more
UNKNOWN_WEIGHT = 1.0  # stones a piece, for an item whose weight neither the source nor a tooltip gives
SELL_SHARE = 0.5      # vendors pay about half what they charge (the median in data/items.json)

# Names the client shows that are not their ModernUO class names (the first four seen in our sessions).
ALIASES = {"gold coin": "Gold", "clean bandage": "Bandage", "empty bottle": "Bottle",
           "tear kite shield": "WoodenKiteShield", "crossbow bolt": "Bolt",
           "platemail": "PlateChest", "plate mail": "PlateChest", "platemail tunic": "PlateChest",
           "female plate": "FemalePlateChest"}
# How the client names armour pieces against ModernUO's class names (Leather Tunic is LeatherChest).
SWAPS = [(r"\bplate ?mail\b", "plate"), (r"\bchain ?mail\b", "chain"), (r"\bring ?mail\b", "ringmail"),
         (r"\bstudded leather\b", "studded"), (r"\b(tunic|armor|breastplate)\b", "chest"),
         (r"\bleggings\b", "legs"), (r"\bsleeves\b", "arms"), (r"\bhelmet\b", "helm")]

ROW = re.compile(r"^(?:\[[\d:.]+\]\s*)?\s*\[(item|container)\]\s+(0x[0-9A-Fa-f]{1,8})\s+(.*?)\s*$")
ADDED = re.compile(r"\[CONTAINER\] \+(\d+) 0x([0-9A-Fa-f]{1,4}) \((0x[0-9A-Fa-f]{1,8})\)")
HUE = re.compile(r"\s+\(hue 0x([0-9A-Fa-f]{1,4})(?: \"[^\"]*\")?\)$")
AMOUNT = re.compile(r"\s+x(\d+)$")
WEIGHT_PROP = re.compile(r"^weight:\s*(\d+(?:\.\d+)?)\s*stones?\b", re.I)
STATUS_WEIGHT = re.compile(r"\bWeight:\s*(\d+)\s*/\s*(\d+)")
NOT_OPENED = "not opened yet"

_cache = {}


def load(path):
    """A JSON file, read once."""
    if path not in _cache:
        with open(path) as f:
            _cache[path] = json.load(f)
    return _cache[path]


def serial(s):
    return f"0x{int(str(s), 16):08X}"


def graphic(g):
    return int(g, 16) if isinstance(g, str) else int(g)


def parse(text):
    """The items in Navrey's listing of a container (`container <serial>`), with or without the log's
    timestamps; other lines are skipped. Each: serial, name (no amount, no hue), amount, hue, whether it is
    a container itself, and its graphic when the text also has the client's `[CONTAINER] +N 0xGGGG (serial)`
    line for it."""
    seen = {serial(m.group(3)): int(m.group(2), 16) for m in ADDED.finditer(text)}
    out = []
    for line in text.splitlines():
        m = ROW.match(line)
        if not m:
            continue
        rest, hue, amount = m.group(3), 0, 1
        if h := HUE.search(rest):
            hue, rest = int(h.group(1), 16), rest[:h.start()]
        if a := AMOUNT.search(rest):
            amount, rest = int(a.group(1)), rest[:a.start()]
        s = serial(m.group(2))
        out.append({"serial": s, "name": rest.strip(), "amount": amount, "hue": hue,
                    "container": m.group(1) == "container", "graphic": seen.get(s)})
    return out


def unopened(text):
    """Whether the listing shows nothing because the container is empty or not opened yet: `use <serial>`
    it and list it again (Navrey prints the same line for both)."""
    return NOT_OPENED in text


def status_weight(text):
    """(weight, maximum) from the status text's `Weight: 60/345`, or None."""
    m = STATUS_WEIGHT.search(text or "")
    return (int(m.group(1)), int(m.group(2))) if m else None


def words(name):
    """A name as plain lowercase words: no amount in front, no article, no punctuation."""
    n = (name or "").lower()
    n = re.sub(r"^\d[\d,]*\s+", "", n)
    n = re.sub(r"^(a|an|the)\s+", "", n)
    n = re.sub(r"[^a-z0-9 ]+", "", n)
    return " ".join(n.split())


def key(text):
    return text.replace(" ", "")


def memo(kind, obj, make):
    """make(obj), worked out once per object (the cache keeps the object, so its id stays its own)."""
    hit = _cache.get((kind, id(obj)))
    if hit is None or hit[0] is not obj:
        hit = _cache[(kind, id(obj))] = (obj, make(obj))
    return hit[1]


def index(items):
    """Name key -> type: the aliases, each type's class name, its name in the source, and a spell scroll's
    spell (ParalyzeScroll is also 'paralyze'). Where two types share a key, the earlier kind of key wins,
    then the type that vendors trade."""
    return memo("index", items, _index)


def _index(items):
    best = {}

    def add(k, t, rank):
        if not k or t not in items:
            return
        score = (rank, 0 if ("pay" in items[t] or "charge" in items[t]) else 1, t)
        if k not in best or score < best[k]:
            best[k] = score
    for name, t in ALIASES.items():
        add(key(words(name)), t, 0)
    for t, e in items.items():
        add(t.lower(), t, 1)
        if e.get("name"):
            add(key(words(e["name"])), t, 2)
        if e.get("family") == "SpellScroll" and t.endswith("Scroll"):
            add(t[:-len("Scroll")].lower(), t, 3)
    return {k: v[2] for k, v in best.items()}


def forms(w):
    """A name's keys to try: as it is, then singular or plural."""
    k = key(w)
    out = [k]
    if k.endswith("ies"):
        out.append(k[:-3] + "y")
    if k.endswith("es"):
        out.append(k[:-2])
    if k.endswith("s"):
        out.append(k[:-1])
    else:
        out.append(k + "s")
    return out


def identify(name, items=None, graphic_id=None):
    """The type an item is, from its name as the client shows it (and its graphic when known):
    (type, how) where how is 'name', 'graphic' or 'guess' (by the longest known end of its name, so
    'a tattered, plainly drawn treasure map' is a TreasureMap); (None, None) when nothing fits."""
    items = items if items is not None else load(ITEMS)
    idx = index(items)
    w = words(name)
    swapped = w
    for pattern, repl in SWAPS:
        swapped = re.sub(pattern, repl, swapped)
    tries = [w] if swapped == w else [w, swapped]
    for t in tries:
        for k in forms(t):
            if k in idx:
                return idx[k], "name"
    if graphic_id is not None:
        hexed = f"0x{graphic_id:04X}"
        found = sorted((0 if "pay" in e else 1, t) for t, e in items.items() if hexed in e.get("graphics", []))
        if found:
            return found[0][1], "graphic"
    for t in tries:
        parts = t.split(" ")
        for start in range(1, len(parts)):
            for k in forms(" ".join(parts[start:])):
                if k in idx:
                    return idx[k], "guess"
    return None, None


def rules(valuables=None):
    """data/valuables.json's rules, their patterns compiled and graphics as numbers."""
    valuables = valuables if valuables is not None else load(VALUABLES)
    return memo("rules", valuables, lambda v: [
        {"why": r["why"], "graphics": {graphic(g) for g in r.get("graphics", [])},
         "types": set(r.get("types", [])), "families": set(r.get("families", [])),
         "names": [re.compile(p, re.I) for p in r.get("names", [])],
         "props": [re.compile(p, re.I) for p in r.get("props", [])],
         "artifact": bool(r.get("artifact"))} for r in v.get("rules", [])])


def valuable(item, entry, tips, compiled):
    """The index and reason of the first valuables rule an item matches, or (None, None). Without its own
    graphic an item is matched by its type's graphics, when its type is known by name or graphic."""
    entry = entry or {}
    if item.get("graphic") is not None:
        graphics = {item["graphic"]}
    else:
        graphics = {graphic(g) for g in entry.get("graphics", [])} if item.get("how") in ("name", "graphic") else set()
    name = words(item["name"])
    for i, r in enumerate(compiled):
        if (graphics & r["graphics"] or item.get("type") in r["types"] or entry.get("family") in r["families"]
                or any(p.search(name) for p in r["names"]) or (r["artifact"] and entry.get("artifact"))
                or any(p.search(line.strip()) for p in r["props"] for line in tips)):
            return i, r["why"]
    return None, None


def stones(piece, n):
    """What n pieces weigh as the server counts a pile: rounded up to whole stones."""
    return math.ceil(piece * n - 1e-9) if piece else 0


def lines_of(tip):
    return tip.splitlines() if isinstance(tip, str) else list(tip or [])


def rank(text, items=None, valuables=None, graphics=None, tooltips=None):
    """Every item in a container listing, in the order to take them, each with what is known of it:
    serial, name, amount, type, how it was known, tier (0 valuable, 1 priced, 2 value unknown, 3 a container,
    which is not taken: list its contents and loot those), gold a piece, stones a piece, why."""
    items = items if items is not None else load(ITEMS)
    compiled = rules(valuables)
    graphics = {serial(k): graphic(v) for k, v in (graphics or {}).items()}
    tooltips = {serial(k): lines_of(v) for k, v in (tooltips or {}).items()}
    out = []
    for order, item in enumerate(parse(text)):
        item = dict(item)
        if item["graphic"] is None and item["serial"] in graphics:
            item["graphic"] = graphics[item["serial"]]
        t, how = identify(item["name"], items, item["graphic"])
        entry = items.get(t, {}) if t else {}
        item.update(type=t, how=how, order=order)
        tips = tooltips.get(item["serial"], [])
        weighed = next((float(m.group(1)) for line in tips if (m := WEIGHT_PROP.match(line.strip()))), None)
        if weighed is not None:
            item["piece"], item["weighed"] = weighed / max(1, item["amount"]), "tooltip"
        elif "weight" in entry:
            item["piece"], item["weighed"] = entry["weight"], "source"
        else:
            item["piece"], item["weighed"] = UNKNOWN_WEIGHT, "guessed"
        if entry.get("pay"):
            item["value"], item["priced"] = float(entry["pay"]), "a vendor pays"
        elif entry.get("charge"):
            item["value"], item["priced"] = entry["charge"] * SELL_SHARE, "half what a vendor charges"
        else:
            item["value"], item["priced"] = None, None
        rule, why = valuable(item, entry, tips, compiled)
        named = t if how in ("name", "graphic") else (f"{t}?" if t else None)  # '?': known by a guess
        if item["container"]:
            item.update(tier=3, rule=None, why="a container: list it with 'container <serial>' and loot what is inside")
        elif rule is not None:
            item.update(tier=0, rule=rule, why=f"valuable, {why}")
        elif item["value"] is not None:
            per_stone = item["value"] / item["piece"] if item["piece"] else math.inf
            item.update(tier=1, rule=None, perStone=per_stone,
                        why=f"{named}: {item['value']:g} gold each ({item['priced']})" +
                            (f", {per_stone:.0f} gold a stone" if math.isfinite(per_stone) else ", weightless"))
        else:
            item.update(tier=2, rule=None, why=f"{named or 'unknown item'}: value unknown, taken if light")
        out.append(item)

    def place(i):
        total = (i["value"] or 0) * i["amount"]
        if i["tier"] == 0:
            return (0, i["rule"], -total, i["order"])
        if i["tier"] == 1:
            return (1, -i["perStone"], -total, i["order"])
        if i["tier"] == 2:
            return (2, i["piece"] * i["amount"], i["order"])  # lightest first
        return (3, i["order"])
    return sorted(out, key=place)


def plan(text, weight, max_weight, items=None, valuables=None, graphics=None, tooltips=None,
         light=LIGHT, min_per_stone=0.0):
    """What to take from a container listing, in order: [(serial, amount, why)], keeping the client's
    weight at or under its maximum. weight and max_weight are the status's `Weight: 60/345`. graphics
    ({serial: graphic}) and tooltips ({serial: lines of `tooltip <serial>`}) are optional; a tooltip's
    `Weight: N Stones` is the stack's weight and its magic properties make an item valuable.
    min_per_stone leaves priced items worth less than that many gold a stone (0: take whatever fits)."""
    room = int(max_weight) - int(weight)
    out = []
    for i in rank(text, items, valuables, graphics, tooltips):
        if i["tier"] == 3:
            continue
        if i["tier"] == 1 and i["perStone"] < min_per_stone:
            continue
        whole = stones(i["piece"], i["amount"])
        if i["tier"] == 2 and whole > light:
            continue
        n = i["amount"]
        if whole > room:
            if i["amount"] == 1 or i["tier"] == 2 or not i["piece"]:
                continue
            n = min(i["amount"], int((room + 1e-9) / i["piece"]))
            while n > 0 and stones(i["piece"], n) > room:
                n -= 1
            if n <= 0:
                continue
        room -= stones(i["piece"], n)
        why = i["why"] + (f"; {n} of {i['amount']} fit" if n < i["amount"] else "")
        if i["weighed"] == "guessed":
            why += f"; weight unknown, counted as {UNKNOWN_WEIGHT:g} stone a piece"
        out.append((i["serial"], n, why))
    return out


def main():
    if len(sys.argv) != 4:
        sys.exit("usage: python3 lab/loot.py <listing file> <weight> <max weight>")
    with open(sys.argv[1]) as f:
        text = f.read()
    for s, n, why in plan(text, int(sys.argv[2]), int(sys.argv[3])):
        print(f"get {s} {n}    # {why}")


if __name__ == "__main__":
    main()
