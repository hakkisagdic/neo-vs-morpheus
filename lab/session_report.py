#!/usr/bin/env python3
"""What happened in one or more recorded agent sessions (lab/uo_agent.py's folders), side by side:

    python3 lab/session_report.py ~/UO/sessions/2026-10-13T08-07-gemma
    python3 lab/session_report.py ~/UO/sessions/*-gemma ~/UO/sessions/*-fable

Per session: the model and its pace, the decisions it noted, deaths and resurrections, damage dealt
and taken, skill gains, gold, the facets it reached and how far it walked. Standard library only.
"""
import json
import os
import re
import sys

DAMAGE = re.compile(r"Damage: (.+) takes (\d+)")
SKILL = re.compile(r"Your skill in (.+?) has increased by (\d+(?:\.\d+)?)")
FACETS = ["Felucca", "Trammel", "Ilshenar", "Malas", "Tokuno", "Ter Mur"]


def lines(path):
    try:
        with open(path, errors="replace") as f:
            return f.read().splitlines()
    except OSError:
        return []


def report(folder):
    with open(os.path.join(folder, "run.json")) as f:
        run = json.load(f)
    me = run.get("system", "").split("Your character ", 1)[-1].split(" ", 1)[0] or "?"
    events = [json.loads(l) for l in lines(os.path.join(folder, "agent.jsonl"))]
    replies = [e for e in events if e.get("kind") == "model"]
    tools = [e for e in events if e.get("kind") == "tool"]
    decisions = [json.loads(l) for l in lines(os.path.join(folder, "decisions.jsonl"))]
    rows = [json.loads(l) for l in lines(os.path.join(folder, "state.jsonl"))]
    states = [r["state"] for r in rows]
    log = lines(os.path.join(folder, "cuolog.txt"))

    dealt = taken = 0
    for l in log:
        m = DAMAGE.search(l)
        if m:
            if m.group(1) == me:
                taken += int(m.group(2))
            else:
                dealt += int(m.group(2))
    gains = {}
    for l in log:
        m = SKILL.search(l)
        if m:
            gains[m.group(1)] = round(gains.get(m.group(1), 0) + float(m.group(2)), 1)
    deaths = sum("You have died" in l for l in log)
    fights = {}
    for e in tools:
        if e.get("name") == "fight":
            outcome = e.get("result", "").split(":", 1)[0]
            fights[outcome] = fights.get(outcome, 0) + 1
    alive = [s for s in states if "charGhost" in s]
    raised = sum(1 for a, b in zip(alive, alive[1:]) if a["charGhost"] and not b["charGhost"])
    walked, facets = 0, []
    for a, b in zip(states, states[1:]):
        if a.get("map") == b.get("map"):
            walked += max(abs(b.get("charPosX", 0) - a.get("charPosX", 0)), abs(b.get("charPosY", 0) - a.get("charPosY", 0)))
    for s in states:
        name = FACETS[s["map"]] if isinstance(s.get("map"), int) and s["map"] < len(FACETS) else None
        if name and (not facets or facets[-1] != name):
            facets.append(name)
    gold = [s["gold"] for s in states if "gold" in s]
    minutes = (rows[-1]["t"] - rows[0]["t"]) / 60 if len(rows) > 1 else 0
    pace = sum(e.get("ms", 0) for e in replies) / len(replies) / 1000 if replies else 0
    return {
        "session": os.path.basename(folder.rstrip("/")),
        "model": run.get("model"),
        "minutes": round(minutes, 1),
        "replies": f"{len(replies)} ({pace:.1f} s each)" if replies else "in claude.jsonl",
        "tool calls": len(tools),
        "decisions": len(decisions),
        "fights (Laya)": ", ".join(f"{k} {v}" for k, v in sorted(fights.items(), key=lambda kv: -kv[1])) or "none",
        "deaths": deaths,
        "resurrected": raised,
        "damage dealt / taken": f"{dealt} / {taken}",
        "skill gains": ", ".join(f"{k} +{v}" for k, v in sorted(gains.items(), key=lambda kv: -kv[1])) or "none",
        "gold": f"{gold[0]} -> {gold[-1]}" if gold else "?",
        "facets": " -> ".join(facets),
        "tiles walked": walked,
    }


def main():
    folders = [f for f in sys.argv[1:] if os.path.exists(os.path.join(f, "run.json"))]
    if not folders:
        sys.exit(__doc__)
    rows = [report(f) for f in folders]
    width = max(len(k) for k in rows[0])
    for r in rows:
        print()
        for k, v in r.items():
            print(f"{k:>{width}}  {v}")


if __name__ == "__main__":
    main()
