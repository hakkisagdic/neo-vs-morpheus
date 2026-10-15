#!/usr/bin/env python3
"""What the world's items are worth, read from ModernUO's source at the pinned commit (vendor/modernuo):

    python3 lab/itemvalues.py                   # writes data/items.json
    python3 lab/itemvalues.py --show sapphire   # the item types whose type or name contains this, as read

For each item class (anything that comes from Item), by type:
  graphics  its graphic(s): its constructors' `: base(0x0F21)`, `ItemID = ...`, its [Flippable] attribute and
            the itemIDs vendors list it with; a class that names none has its base class's
  name      only when the source gives it as a plain string: DefaultName, or the text after a LabelNumber's
            cliloc number (`LabelNumber => 1041243; // a contract of employment`); otherwise left out
  label     that cliloc number
  weight    in stones, where the source gives one (DefaultWeight, `Weight =`), inherited as the code inherits
            it; without one an item weighs what the client's tiledata says, which is not in the source
  pay       what a vendor pays a player for one: the best price in any vendor's sell list, `Add(typeof(X), 25)`
  buyers    the vendors (their SBInfo lists) that buy it
  charge    what a vendor charges for one: the lowest price in any buy list, `GenericBuyInfo(typeof(X), 50, ...)`
  family    the class it comes from, right below Item (BaseWeapon, BaseArmor, SpellScroll, BaseReagent, ...)
  artifact  its ArtifactRarity, for artifacts
Code that depends on the era is read for our shard's: Mondain's Legacy (NEO_EXPANSION 7). Gold counts 1 each.
Vendors' prices are their lists' base prices: a vendor pays more for a well-made or old-style magic weapon or
armour (GenericSellInfo), which a corpse's listing cannot show. Standard library only.
"""
import argparse
import ast
import glob
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECTS = os.path.join(ROOT, "vendor", "modernuo", "Projects")
SOURCE = os.path.join(PROJECTS, "UOContent")
OUT = os.path.join(ROOT, "data", "items.json")

ERAS = ["None", "T2A", "UOR", "UOTD", "LBR", "AOS", "SE", "ML", "SA", "HS", "TOL", "EJ"]
EXPANSION = ERAS.index("ML")  # our shard: NEO_EXPANSION 7 (docker-compose.yml, lab/compose.yml)
# Files that define the vendor machinery rather than list what a vendor trades.
NOT_LISTS = {"GenericBuy.cs", "GenericSell.cs", "BeverageBuy.cs", "AnimalBuy.cs", "PresetMapBuy.cs",
             "BaseVendor.cs", "AdvancedSearchThreadWorker.cs"}

LITERALS = re.compile(r'//[^\n]*|/\*.*?\*/|@"(?:[^"]|"")*"|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'', re.S)
CLASS = re.compile(r"((?:\b(?:public|internal|private|protected|abstract|sealed|static|partial|new|unsafe|file)\s+)*)"
                   r"\bclass\s+(\w+)\s*(?:<[^>{;]*>)?\s*(?::\s*([^{;]+?))?\s*(?:where\s[^{;]*)?\{")
HEX = re.compile(r"\b0x([0-9A-Fa-f]+)\b")
WEIGHT = re.compile(r"\bDefaultWeight\s*(?:=>\s*([^;]+);|\{\s*get\s*\{\s*return\s+([^;]+);)")
SET_WEIGHT = re.compile(r"(?<![\w.])Weight\s*=\s*(-?\d+(?:\.\d+)?)\s*;")
DEFAULT_NAME = re.compile(r"\bDefaultName\s*(?:=>|\{\s*get\s*\{\s*return)\s*(\$?@?\"(?:\\.|[^\"\\])*\"|[^;]+);")
LABEL = re.compile(r"\bLabelNumber\s*(?:=>|\{\s*get\s*\{\s*return)\s*([^;]+);")
RARITY = re.compile(r"\bArtifactRarity\s*=>\s*(\d+)\s*;")
FLIPPABLE = re.compile(r"\[\s*Flippable\s*\(([^)]*)\)\s*\]")
ITEM_ID = re.compile(r"(?<![\w.])ItemID\s*=\s*([^;=][^;]*);")
TYPE_ARRAY = re.compile(r"\bType\[\]\s+(\w+)\s*\{\s*get;\s*\}\s*=\s*[\[{](.*?)[\]}]\s*;", re.S)
TYPEOF = re.compile(r"^typeof\(\s*(?:[\w.]+\.)?(\w+)\s*\)$")


def literals_blanked(text, strings=False):
    """The text with its comments (and with strings=True, the insides of its string and char literals) turned
    into spaces, newlines kept, so that every position still points at the same place in the original."""
    def blank(m):
        s = m.group(0)
        if s.startswith("/"):
            return re.sub(r"[^\n]", " ", s)
        if not strings:
            return s
        q = 2 if s.startswith('@"') else 1
        return s[:q] + re.sub(r"[^\n]", " ", s[q:-1]) + s[-1]
    return LITERALS.sub(blank, text)


def braces(code):
    """Matching braces in code without comments or strings: {position of an opening one: its closing one}."""
    stack, found = [], {}
    for m in re.finditer(r"[{}]", code):
        if m.group(0) == "{":
            stack.append(m.start())
        elif stack:
            found[stack.pop()] = m.start()
    return found


def closing(text, start):
    """The position of the bracket closing the one at `start` ('(' or '{'), counting only that kind."""
    o = text[start]
    c = {"(": ")", "{": "}", "[": "]"}[o]
    depth = 0
    for i in range(start, len(text)):
        if text[i] == o:
            depth += 1
        elif text[i] == c:
            depth -= 1
            if depth == 0:
                return i
    return len(text) - 1


def arguments(text):
    """A call's argument list split at its top-level commas."""
    out, depth, cur = [], 0, []
    for ch in text:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    if "".join(cur).strip():
        out.append("".join(cur).strip())
    return out


def era(cond):
    """A condition that reads only the era (Core.AOS, !Core.SE, Core.Expansion >= Expansion.ML, && and ||) as
    True or False for our shard; None for anything else."""
    value = evaluate(cond)
    return None if value is None else bool(value)


def to_python(expr):
    """A C# expression in Python's syntax: era flags as booleans, ?: as if-else, && || ! as and or not."""
    expr = re.sub(r"\bCore\.Expansion\b", str(EXPANSION), expr)
    expr = re.sub(r"\bExpansion\.(\w+)\b", lambda m: str(ERAS.index(m.group(1))) if m.group(1) in ERAS else m.group(0), expr)
    expr = re.sub(r"\bCore\.(\w+)\b", lambda m: str(ERAS.index(m.group(1)) <= EXPANSION) if m.group(1) in ERAS else m.group(0), expr)
    expr = re.sub(r"\b(\d+(?:\.\d+)?)(?:[fFdDmM]|[uU]?[lL])\b", r"\1", expr)  # 1.0f, 10L (not 0x2F)
    expr = expr.replace("&&", " and ").replace("||", " or ")
    expr = re.sub(r"!(?!=)", " not ", expr)
    step = {"(": 1, "[": 1, ")": -1, "]": -1}
    depth, q = 0, None
    for i, ch in enumerate(expr):
        depth += step.get(ch, 0)
        if ch == "?" and depth == 0:
            q = i
            break
    if q is None:
        return expr
    depth, nested = 0, 0
    for j in range(q + 1, len(expr)):
        ch = expr[j]
        depth += step.get(ch, 0)
        if depth == 0 and ch == "?":
            nested += 1
        elif depth == 0 and ch == ":":
            if nested == 0:
                return f"({to_python(expr[q + 1:j])}) if ({to_python(expr[:q])}) else ({to_python(expr[j + 1:])})"
            nested -= 1
    return expr


def evaluate(expr, names=None):
    """A C# constant expression's value, or None when it reads anything but numbers, the era and `names`.
    Division of two integers is C#'s: whole numbers."""
    names = names or {}
    try:
        tree = ast.parse(to_python(expr.strip()).strip(), mode="eval").body
    except SyntaxError:
        return None

    def ev(n):
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float, bool)):
            return n.value
        if isinstance(n, ast.Name):
            if n.id in ("True", "False"):
                return n.id == "True"
            if n.id in names:
                return names[n.id]
            raise ValueError(n.id)
        if isinstance(n, ast.UnaryOp):
            v = ev(n.operand)
            return {ast.USub: lambda: -v, ast.UAdd: lambda: v, ast.Not: lambda: not v}[type(n.op)]()
        if isinstance(n, ast.BinOp):
            a, b = ev(n.left), ev(n.right)
            if isinstance(n.op, ast.Div):
                return int(a / b) if isinstance(a, int) and isinstance(b, int) else a / b
            ops = {ast.Add: lambda: a + b, ast.Sub: lambda: a - b, ast.Mult: lambda: a * b, ast.Mod: lambda: a % b}
            return ops[type(n.op)]()
        if isinstance(n, ast.BoolOp):
            vals = [ev(v) for v in n.values]
            return all(vals) if isinstance(n.op, ast.And) else any(vals)
        if isinstance(n, ast.Compare) and len(n.ops) == 1:
            a, b = ev(n.left), ev(n.comparators[0])
            return {ast.Eq: a == b, ast.NotEq: a != b, ast.Lt: a < b, ast.LtE: a <= b,
                    ast.Gt: a > b, ast.GtE: a >= b}[type(n.ops[0])]
        if isinstance(n, ast.IfExp):
            return ev(n.body) if ev(n.test) else ev(n.orelse)
        raise ValueError(ast.dump(n))

    try:
        return ev(tree)
    except (ValueError, KeyError, TypeError, ZeroDivisionError):
        return None


def statement_end(code, pos):
    """Where the statement starting at `pos` ends: a block, an if with its else, or up to its ';'."""
    pos = len(code) - len(code[pos:].lstrip())
    if code.startswith("{", pos):
        return closing(code, pos)
    m = re.compile(r"if\s*\(").match(code, pos)
    if m:
        end = statement_end(code, closing(code, m.end() - 1) + 1)
        e = re.compile(r"\s*else\b").match(code, end + 1)
        return statement_end(code, e.end()) if e else end
    semi = code.find(";", pos)
    return len(code) - 1 if semi < 0 else semi


def prune(code):
    """Code without the if/else branches our era never takes (`if (Core.AOS)` stays, `if (!Core.AOS)` goes).
    A branch on anything else stays, whichever way it goes: it may be taken."""
    out, pos = [], 0
    for m in re.finditer(r"\bif\s*\(", code):
        if m.start() < pos:
            continue
        cond_end = closing(code, m.end() - 1)
        then_end = statement_end(code, cond_end + 1)
        e = re.compile(r"\s*else\b").match(code, then_end + 1)
        else_end = statement_end(code, e.end()) if e else then_end
        taken = era(code[m.end():cond_end])
        if taken is None:
            continue
        out.append(code[pos:m.start()])
        out.append(" " * (m.end() - m.start()) + " " * (cond_end - m.end() + 1))
        then = code[cond_end + 1:then_end + 1]
        rest = code[then_end + 1:else_end + 1]
        if taken:
            out.append(prune(then))
            out.append(re.sub(r"[^\n]", " ", rest))
        else:
            out.append(re.sub(r"[^\n]", " ", then))
            if e:  # the else branch is the one taken
                out.append(" " * (e.end() - then_end - 1))
                out.append(prune(code[e.end():else_end + 1]))
        pos = else_end + 1
    out.append(code[pos:])
    return "".join(out)


class Source:
    """One .cs file: its text without comments, the same with strings blanked, and its classes."""

    def __init__(self, path):
        with open(path, encoding="utf-8", errors="replace") as f:
            self.raw = f.read()
        self.path = path
        self.text = literals_blanked(self.raw)
        self.code = literals_blanked(self.raw, strings=True)
        closes = braces(self.code)
        self.classes = []
        for m in CLASS.finditer(self.code):
            open_at = m.end() - 1
            bases = [b.strip() for b in arguments(m.group(3) or "")]
            self.classes.append({"name": m.group(2), "abstract": "abstract" in m.group(1), "bases": bases,
                                 "partial": "partial" in m.group(1), "start": m.start(), "open": open_at,
                                 "end": closes.get(open_at, len(self.code) - 1)})
        for c in self.classes:
            c["outer"] = next((o["name"] for o in sorted(self.classes, key=lambda o: o["open"], reverse=True)
                               if o["open"] < c["start"] and o["end"] > c["end"]), None)

    def own(self, c, text=None):
        """A class's body without the classes nested in it."""
        text = text or self.text
        body = list(text[c["open"]:c["end"] + 1])
        for n in self.classes:
            if c["open"] < n["start"] and n["end"] <= c["end"]:
                for i in range(n["start"] - c["open"], n["end"] - c["open"] + 1):
                    if body[i] != "\n":
                        body[i] = " "
        return "".join(body)

    def attributes(self, c):
        """The text of the attributes written right before a class's declaration."""
        head = self.code[:c["start"]]
        cut = max(head.rfind("{"), head.rfind("}"), head.rfind(";"))
        return self.text[cut + 1:c["start"]]


def base_name(bases):
    """The class a class comes from: the first name in its base list, unless that is an interface."""
    if not bases:
        return None
    first = re.sub(r"<.*", "", bases[0]).split(".")[-1].strip()
    return None if re.match(r"I[A-Z]", first) else first


def hexes(text):
    return [int(h, 16) for h in HEX.findall(text)]


def constructor_graphics(name, own):
    """The graphics a class's constructors give: the hex numbers in the first argument of `: base(...)` or
    `: this(...)` that has any (an itemID comes before a hue), and in `ItemID = ...`."""
    found = []
    for m in re.finditer(r"\b(?:public|protected|internal|private)\s+" + re.escape(name) + r"\s*\(", own):
        params_end = closing(own, m.end() - 1)
        call = re.compile(r"\s*:\s*(?:base|this)\s*\(").match(own, params_end + 1)
        if call:
            for arg in arguments(own[call.end():closing(own, call.end() - 1)]):
                if hexes(arg):
                    found += hexes(arg)
                    break
    for m in ITEM_ID.finditer(own):
        found += hexes(m.group(1))
    return found


def read_class(src, c):
    """What one class's own code says (nothing inherited yet). A key set to None declares that the class
    has the thing but not in a form read here, which stops it being inherited."""
    own = src.own(c, src.code)  # strings blanked: brackets inside them cannot mislead
    text = src.own(c)           # strings kept, for names
    rel = os.path.relpath(src.path, SOURCE) if src.path.startswith(SOURCE) else None
    k = {"type": c["name"], "base": base_name(c["bases"]), "abstract": c["abstract"], "file": rel,
         "nested": c["outer"] is not None, "partial": c["partial"]}
    graphics = []
    for m in FLIPPABLE.finditer(src.attributes(c)):
        graphics += hexes(m.group(1))
    graphics += constructor_graphics(c["name"], own)
    k["graphics"] = list(dict.fromkeys(g for g in graphics if 0 < g < 0x10000))
    if m := WEIGHT.search(own):
        k["weightExpr"] = (m.group(1) or m.group(2)).strip()
    elif m := SET_WEIGHT.search(own):
        k["weightExpr"] = m.group(1)
    if m := DEFAULT_NAME.search(text):
        v = m.group(1).strip()
        k["nameDecl"] = v[1:-1].replace('\\"', '"') if re.fullmatch(r'"(?:\\.|[^"\\])*"', v) else None
    if m := LABEL.search(text):
        v = m.group(1).strip()
        k["label"] = int(v) if re.fullmatch(r"\d+", v) else None
        said = ""
        if k["label"]:
            at = c["open"] + m.end()
            eol = src.raw.find("\n", at)
            comment = re.match(r"\s*//\s*(.+?)\s*$", src.raw[at:eol if eol >= 0 else len(src.raw)])
            said = comment.group(1) if comment else ""
        plain = said and "~" not in said and len(said) <= 60 and not re.search(r"\d{4,}", said)
        k.setdefault("nameDecl", said if plain else None)
    if m := RARITY.search(own):
        k["artifact"] = int(m.group(1))
    return k


def chain(t, classes):
    """A class and the classes it comes from, nearest first."""
    out, seen = [], set()
    while t in classes and t not in seen:
        seen.add(t)
        out.append(t)
        t = classes[t]["base"]
    if t and t not in seen:
        out.append(t)
    return out


def inherited(t, classes, key):
    """The nearest declaration of `key` along a class's chain (a declaration of None stops the search)."""
    for a in chain(t, classes):
        if a in classes and key in classes[a]:
            return classes[a][key]
    return None


def merge(old, new):
    """Two parts of one partial class as one: only one part needs to name the base class, and the
    constructor, the weight and the name may each be in any part."""
    out = dict(old)
    out["base"] = old["base"] or new["base"]
    out["abstract"] = old["abstract"] or new["abstract"]
    out["graphics"] = list(dict.fromkeys(old["graphics"] + new["graphics"]))
    if new["graphics"] and not old["graphics"]:
        out["file"] = new["file"]  # the part with the constructor
    for key in ("weightExpr", "nameDecl", "label", "artifact"):
        if key not in out and key in new:
            out[key] = new[key]
    return out


def scan_classes(paths):
    classes, sources = {}, []
    for path in paths:
        src = Source(path)
        sources.append(src)
        for c in src.classes:
            k = read_class(src, c)
            old = classes.get(k["type"])
            if old is None:
                classes[k["type"]] = k
            elif old["partial"] and k["partial"] and not old["nested"] and not k["nested"]:
                classes[k["type"]] = merge(old, k)
            elif old["nested"] and not k["nested"]:
                classes[k["type"]] = k  # one name, several classes (nested helpers): vendors mean the top-level one
    return classes, sources


def loot_arrays(sources):
    """Loot's type tables (Loot.RegularScrollTypes and the like): name -> the type names in it."""
    for src in sources:
        if src.path.endswith(os.path.join("Misc", "Loot.cs")):
            return {m.group(1): [TYPEOF.match(a).group(1) for a in arguments(m.group(2)) if TYPEOF.match(a)]
                    for m in TYPE_ARRAY.finditer(src.text)}
    return {}


def vendor_lists(sources, arrays):
    """Every vendor's prices: (vendor, type, 'pay'|'charge', price, itemID or None)."""
    out = []
    for src in sources:
        if os.path.basename(src.path) in NOT_LISTS or ("BuyInfo" not in src.code and "SellInfo" not in src.code):
            continue
        for c in src.classes:
            bases = " ".join(c["bases"])
            if "GenericSellInfo" in bases:
                kind = "pay"
            elif "GenericBuyInfo" in bases:
                kind = "charge"
            else:
                continue
            vendor = c["outer"] or c["name"]
            code = prune(src.own(c, src.code))
            code = loops(code, arrays, vendor, kind, out)
            if kind == "pay":
                for m in re.finditer(r"\bAdd\(\s*typeof\(\s*(?:[\w.]+\.)?(\w+)\s*\)\s*,\s*([^;]+?)\)\s*;", code):
                    price = evaluate(m.group(2))
                    if isinstance(price, int):
                        out.append((vendor, m.group(1), "pay", price, None))
                continue
            for m in re.finditer(r"\bnew\s+(\w*BuyInfo)\s*\(", code):
                if m.group(1) == "AnimalBuyInfo":
                    continue  # creatures, not items
                args = arguments(code[m.end():closing(code, m.end() - 1)])
                at = next((i for i, a in enumerate(args) if TYPEOF.match(a)), None)
                if at is None:
                    continue
                numbers = [a for a in args[at + 1:] if not re.match(r"[A-Z]\w*\.\w+$", a)]  # BeverageType.Ale
                price = evaluate(numbers[0]) if numbers else None
                item_id = evaluate(numbers[2]) if len(numbers) > 2 else None
                if isinstance(price, int):
                    out.append((vendor, TYPEOF.match(args[at]).group(1), "charge", price,
                                item_id if isinstance(item_id, int) else None))
    return out


def loops(code, arrays, vendor, kind, out):
    """Reads the loops over a Loot table (`for (var i = 0; i < types.Length; ++i) Add(types[i], ...)`), puts
    their prices in `out` and returns the code without them."""
    for m in reversed(list(re.finditer(r"\bfor\s*\(", code))):
        head_end = closing(code, m.end() - 1)
        body_end = statement_end(code, head_end + 1)
        body = code[head_end + 1:body_end + 1]
        used = re.search(r"\b(\w+)\[i\]", body)
        source = used and re.search(r"\bvar\s+" + used.group(1) + r"\s*=\s*Loot\.(\w+)\s*;", code)
        if not source or source.group(1) not in arrays:
            continue
        types = arrays[source.group(1)]
        local = {k: int(v) for k, v in re.findall(r"\bvar\s+(\w+)\s*=\s*(\d+)\s*;", code)}
        head = code[m.end():head_end].split(";")
        limits = [evaluate(x.replace(used.group(1) + ".Length", str(len(types))), local)
                  for x in re.findall(r"\bi\s*<\s*([^&|]+)", head[1] if len(head) > 1 else "")]
        bound = min([len(types)] + [x for x in limits if isinstance(x, int)])
        pattern = (r"\bAdd\(\s*" + used.group(1) + r"\[i\]\s*,\s*([^;]+?)\)\s*;" if kind == "pay" else
                   r"\bnew\s+GenericBuyInfo\(\s*" + used.group(1) + r"\[i\]\s*,\s*([^,]+),")
        for p in re.finditer(pattern, body):
            for i in range(bound):
                price = evaluate(p.group(1), dict(local, i=i))
                if isinstance(price, int):
                    out.append((vendor, types[i], kind, price, None))
        code = code[:m.start()] + re.sub(r"[^\n]", " ", code[m.start():body_end + 1]) + code[body_end + 1:]
    return code


def is_item(t, classes):
    return "Item" in chain(t, classes)


def family(t, classes):
    """The class right below Item in a class's chain (BaseWeapon for a katana), when that is not the class."""
    c = chain(t, classes)
    if "Item" not in c:
        return None
    i = c.index("Item")
    return c[i - 1] if i >= 2 else None


def build():
    paths = sorted(glob.glob(os.path.join(SOURCE, "**", "*.cs"), recursive=True))
    server = sorted(glob.glob(os.path.join(PROJECTS, "Server", "**", "*.cs"), recursive=True))
    classes, sources = scan_classes(paths + server)
    prices = vendor_lists(sources, loot_arrays(sources))
    items = {}
    for t, k in classes.items():
        if k["abstract"] or k["file"] is None or not is_item(t, classes):
            continue
        e = {"file": k["file"]}
        graphics = next((classes[a]["graphics"] for a in chain(t, classes) if a in classes and classes[a]["graphics"]), [])
        if graphics:
            e["graphics"] = graphics
        name = inherited(t, classes, "nameDecl")
        if name:
            e["name"] = name
        label = inherited(t, classes, "label")
        if label:
            e["label"] = label
        expr = inherited(t, classes, "weightExpr")
        if expr is not None:
            w = evaluate(expr, {"ItemID": graphics[0]} if graphics else None)
            if isinstance(w, (int, float)) and not isinstance(w, bool) and w >= 0:
                e["weight"] = round(float(w), 6)
        if f := family(t, classes):
            e["family"] = f
        if r := inherited(t, classes, "artifact"):
            e["artifact"] = r
        items[t] = e
    for vendor, t, kind, price, item_id in prices:
        if t not in items:
            if t not in classes or not is_item(t, classes):
                continue  # not an item (a creature, a deed's target, an unknown name)
            items[t] = {"file": classes[t]["file"]}
        e = items[t]
        if kind == "pay":
            e["pay"] = max(e.get("pay", 0), price)
            e["buyers"] = sorted(set(e.get("buyers", [])) | {vendor})
        else:
            e["charge"] = min(e.get("charge", price), price)
        if item_id and 0 < item_id < 0x10000 and item_id not in e.get("graphics", []):
            e["graphics"] = e.get("graphics", []) + [item_id]
    if "Gold" in items:
        items["Gold"]["pay"] = 1  # money: a coin is a gold piece
    for e in items.values():
        if "graphics" in e:
            e["graphics"] = [f"0x{g:04X}" for g in e["graphics"]]
    useful = ("graphics", "weight", "name", "pay", "charge", "artifact")
    return {t: e for t, e in items.items() if any(k in e for k in useful)}  # not addon parts and the like


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--show", help="print the item types whose type or name contains this")
    args = ap.parse_args()
    items = build()
    if args.show:
        for t, e in sorted(items.items()):
            if args.show.lower() in t.lower() or args.show.lower() in e.get("name", "").lower():
                print(t, json.dumps(e))
        return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(items, f, indent=0, sort_keys=True)
    count = lambda key: sum(1 for e in items.values() if key in e)  # noqa: E731
    print(f"{len(items)} item types in {OUT}: {count('graphics')} with graphics, {count('pay')} that vendors buy, "
          f"{count('charge')} that vendors sell, {count('weight')} with weights, {count('name')} with names, "
          f"{count('artifact')} artifacts")


if __name__ == "__main__":
    main()
