#!/usr/bin/env python3
"""The world's creatures as data, read from ModernUO's source at the pinned commit (vendor/modernuo):

    python3 lab/bestiary.py                 # writes data/bestiary.json
    python3 lab/bestiary.py --show lich     # one creature, as read

For each creature class with an AI: its name and body, the AI (melee, mage, archer, animal) and when it
fights (FightMode: Aggressor only answers attacks, Closest and Evil go for you), strength, dexterity,
intelligence, hit points, damage and its kinds, resistances, skills, fame, karma and armour. Game facts
live in data, not in a model (docs: the decision method); `danger` turns them into how a fight against
a creature would likely go for a given fighter, for the strategist's eyes and for an oracle's labels.
Standard library only.
"""
import argparse
import glob
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "vendor", "modernuo", "Projects", "UOContent", "Mobiles")
OUT = os.path.join(ROOT, "data", "bestiary.json")

CTOR = re.compile(r"public\s+(\w+)\s*\([^)]*\)\s*:\s*base\(\s*AIType\.(\w+)\s*(?:,\s*([^)]*?))?\)\s*\{")
NUM = r"(-?\d+(?:\.\d+)?)"
PAIR = re.compile(r"\b(SetStr|SetDex|SetInt|SetHits|SetStam|SetMana|SetDamage)\(\s*" + NUM + r"(?:\s*,\s*" + NUM + r")?\s*\)")
RESIST = re.compile(r"SetResistance\(\s*ResistanceType\.(\w+)\s*,\s*" + NUM + r"(?:\s*,\s*" + NUM + r")?\s*\)")
DTYPE = re.compile(r"SetDamageType\(\s*ResistanceType\.(\w+)\s*,\s*" + NUM + r"\s*\)")
SKILL = re.compile(r"SetSkill\(\s*SkillName\.(\w+)\s*,\s*" + NUM + r"(?:\s*,\s*" + NUM + r")?\s*\)")
SCALAR = re.compile(r"\b(Fame|Karma|VirtualArmor|ControlSlots|Body)\s*=\s*" + NUM)
NAME = re.compile(r'DefaultName\s*=>\s*"([^"]+)"|\bName\s*=\s*"([^"]+)"')
POISON_IMMUNE = re.compile(r"PoisonImmune\s*=>\s*Poison\.(\w+)")
HIT_POISON = re.compile(r"HitPoison\s*=>\s*Poison\.(\w+)")


def body_of(text, start):
    """The constructor's body: from its opening brace to the matching closing one."""
    depth, i = 0, start
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
        i += 1
    return text[start:]


def read(path):
    text = open(path, encoding="utf-8", errors="replace").read()
    out = []
    for m in CTOR.finditer(text):
        cls, ai, rest = m.group(1), m.group(2), m.group(3) or ""
        body = body_of(text, m.end() - 1)
        fight = re.search(r"FightMode\.(\w+)", rest)
        c = {"type": cls, "ai": ai.removeprefix("AI_").lower(), "fightMode": fight.group(1) if fight else "Closest",
             "file": os.path.relpath(path, SOURCE)}
        for k, a, b in PAIR.findall(body):
            c[k[3:].lower()] = [float(a), float(b or a)]
        c["damageTypes"] = {k.lower(): float(v) for k, v in DTYPE.findall(body)}
        c["resist"] = {k.lower(): [float(a), float(b or a)] for k, a, b in RESIST.findall(body)}
        c["skills"] = {k: [float(a), float(b or a)] for k, a, b in SKILL.findall(body)}
        for k, v in SCALAR.findall(body):
            c[k[0].lower() + k[1:]] = float(v)
        names = NAME.findall(text)
        c["name"] = next((a or b for a, b in names if a or b), cls)
        if p := POISON_IMMUNE.search(text):
            c["poisonImmune"] = p.group(1)
        if p := HIT_POISON.search(text):
            c["hitPoison"] = p.group(1)
        if "hits" in c and "damage" in c:
            out.append(c)
    return out


def build():
    creatures = {}
    for path in sorted(glob.glob(os.path.join(SOURCE, "**", "*.cs"), recursive=True)):
        for c in read(path):
            creatures.setdefault(c["type"], c)
    return creatures


def mid(r, default=0.0):
    return (r[0] + r[1]) / 2 if r else default


def danger(c, me):
    """How a fight would likely go, as a share of the fighter's health lost before the creature dies.
    me: hits, swords (the fighter's weapon skill), tactics, anatomy, parry, damage (the weapon's average)
    and swing (seconds). A rough model of ModernUO's combat (AOS hit chance, damage bonuses, armour),
    good for telling a rat from a lich, not for a duel."""
    skills = c.get("skills", {})
    def hit_chance(attack, defend):
        return max(0.02, min(1.0, (attack + 20) / ((defend + 20) * 2)))
    their_attack = max(mid(skills.get("Wrestling")), mid(skills.get("Archery")))
    mine = hit_chance(me["swords"], their_attack) * me["damage"] * (1 + me["tactics"] / 160 + me["anatomy"] / 200)
    mine *= 1 - mid(c.get("resist", {}).get("physical"), 0) / 100
    their = hit_chance(their_attack, me["parry"] / 2 + me["swords"] / 2) * mid(c.get("damage")) * (1 + mid(skills.get("Tactics")) / 160)
    their *= 1 - me.get("armor", 15) / 100
    their_per_s = their / 2.75
    if c.get("ai") == "mage" and mid(skills.get("Magery")) > 0:
        their_per_s += mid(skills.get("Magery")) / 100 * 22 / 4.5  # roughly a damage spell every 4.5 s
    seconds = mid(c.get("hits")) / max(0.1, mine / me["swing"])
    return {"seconds": round(seconds, 1), "loss": round(their_per_s * seconds / me["hits"], 2)}


def level(loss):
    return "low" if loss < 0.3 else "medium" if loss < 0.7 else "high" if loss < 1.2 else "deadly"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--show", help="print the creatures whose type or name contains this")
    args = ap.parse_args()
    creatures = build()
    if args.show:
        me = {"hits": 85, "swords": 50, "tactics": 50, "anatomy": 50, "parry": 30, "damage": 16, "swing": 3.75}
        for c in creatures.values():
            if args.show.lower() in c["type"].lower() or args.show.lower() in c["name"].lower():
                d = danger(c, me)
                print(json.dumps(c), "\n  danger for a young swordsman:", d, level(d["loss"]))
        return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(creatures, f, indent=0, sort_keys=True)
    ais = {}
    for c in creatures.values():
        ais[c["ai"]] = ais.get(c["ai"], 0) + 1
    print(f"{len(creatures)} creatures in {OUT}: " + ", ".join(f"{k} {v}" for k, v in sorted(ais.items(), key=lambda kv: -kv[1])))


if __name__ == "__main__":
    main()
