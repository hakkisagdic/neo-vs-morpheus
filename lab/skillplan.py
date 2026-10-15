#!/usr/bin/env python3
"""A character's skill and stat plan, kept within its shard's caps, turned into the game's locks:

    python3 lab/skillplan.py warrior-novice              # the plan, checked against the caps
    python3 lab/skillplan.py warrior-novice --navrey     # the locks the character should have now (Navrey's
                                                         # `skills` and state), and the commands that set them

UO caps the total of a character's skills (700 on our ModernUO) and of its stats (225), and a skill
only gains while the total is under the cap unless another skill is set to drop. Fighting trains
skills by the way: Focus gained 25 to 48 points in a 30-minute session on the training ground. So a
plan names where the character is headed (templates/<id>.json "plan": skill and stat targets) and
its locks follow from it: a planned skill goes up until it reaches its target and is then locked;
every other skill goes down, giving its points back as the planned ones gain; a stat goes up below
its target, down above it, and is locked at it. The caps come from the shard's profile
(data/shards.json). Standard library only.
"""
import argparse
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS = os.path.join(ROOT, "data", "skills.json")
SHARDS = os.path.join(ROOT, "data", "shards.json")
TEMPLATES = os.path.join(ROOT, "templates")
LINE = re.compile(r"^\[SKILL\] (.+?)\s+(\d+(?:\.\d+)?) \(base\s+(\d+(?:\.\d+)?)\)\s*(up|down|locked)?", re.I)


def load(path):
    with open(path) as f:
        return json.load(f)


def titles():
    """{enum name: the title the client shows}, e.g. Swords -> Swordsmanship."""
    return {s["name"]: s["title"] for s in load(SKILLS)}


def plan_of(template):
    """The template's plan, its skills by the client's titles; None when it has none."""
    t = load(os.path.join(TEMPLATES, f"{template}.json"))
    plan = t.get("plan")
    if not plan:
        return None
    named = titles()
    return {"skills": {named.get(k, k): v for k, v in plan.get("skills", {}).items()}, "stats": dict(plan.get("stats", {}))}


def check(plan, caps):
    """What in a plan the shard's caps do not allow."""
    problems = []
    total = sum(plan["skills"].values())
    if total > caps["skillsCap"]:
        problems.append(f"the planned skills add up to {total:g}, over the cap of {caps['skillsCap']}")
    problems += [f"{k} {v:g} is over a skill's cap of {caps['skillCap']}" for k, v in plan["skills"].items() if v > caps["skillCap"]]
    stats = sum(plan["stats"].values())
    if stats > caps["statCap"]:
        problems.append(f"the planned stats add up to {stats}, over the cap of {caps['statCap']}")
    return problems


def parse_skills(lines):
    """Navrey's `skills` lines as {title: (value, base, lock)}."""
    out = {}
    for l in lines:
        m = LINE.match(l.strip())
        if m:
            out[m.group(1)] = (float(m.group(2)), float(m.group(3)), (m.group(4) or "").lower() or None)
    return out


def skill_locks(plan, now, every=False):
    """{title: up|down|locked} for every skill the character has (`now` from parse_skills): by base value, since
    bonuses from items do not count towards the cap. every: also the skills at 0, which Navrey's `skills`
    leaves out (their locks are unknown, so a first application sets them all)."""
    wanted = {}
    base_of = {title: base for title, (_value, base, _lock) in now.items()}
    for title in ([s["title"] for s in load(SKILLS)] if every else list(now)):
        target, base = plan["skills"].get(title), base_of.get(title, 0.0)
        wanted[title] = "down" if target is None else "locked" if base >= target else "up"
    return wanted


def stat_locks(plan, stats):
    """{str|dex|int: up|down|locked} from the stats now ({"str": 70, ...})."""
    out = {}
    for k, target in plan["stats"].items():
        v = stats.get(k)
        if v is not None:
            out[k] = "up" if v < target else "down" if v > target else "locked"
    return out


def commands(now, wanted, stats_now=None, stats_wanted=None):
    """The client commands that change what differs: `skilllock <title> <lock>`, `statlock <stat> <lock>`."""
    out = [f"skilllock {title} {lock}" for title, lock in sorted(wanted.items()) if (now.get(title) or (None, None, None))[2] != lock]
    for k, lock in sorted((stats_wanted or {}).items()):
        if (stats_now or {}).get(k, "").lower() != lock:
            out.append(f"statlock {k} {lock}")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("template")
    ap.add_argument("--shard", default="laya", help="its caps from data/shards.json")
    ap.add_argument("--navrey", action="store_true", help="read the character's skills and stats from the running Navrey client")
    args = ap.parse_args()
    plan = plan_of(args.template)
    if not plan:
        raise SystemExit(f"templates/{args.template}.json has no plan")
    caps = load(SHARDS)[args.shard]
    print(f"plan for {args.template} on {args.shard} (caps: skills {caps['skillsCap']}, one skill {caps['skillCap']}, stats {caps['statCap']}):")
    print("  skills: " + ", ".join(f"{k} {v:g}" for k, v in plan["skills"].items()) + f" (total {sum(plan['skills'].values()):g})")
    print("  stats: " + ", ".join(f"{k} {v}" for k, v in plan["stats"].items()))
    for p in check(plan, caps):
        print("  PROBLEM: " + p)
    if args.navrey:
        import uo_agent
        now = parse_skills(uo_agent.command("skills", harness=True).splitlines())
        state = uo_agent.read_json(uo_agent.STATE)
        stats = {k: state.get(k) for k in ("str", "dex", "int")}
        locks = {k: state.get(f"{k}Lock") for k in ("str", "dex", "int")}
        wanted, stats_wanted = skill_locks(plan, now, every=True), stat_locks(plan, stats)
        for cmd in commands(now, wanted, {k: (v or "") for k, v in locks.items()}, stats_wanted):
            print("  " + cmd)


if __name__ == "__main__":
    main()
