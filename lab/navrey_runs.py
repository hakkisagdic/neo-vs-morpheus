#!/usr/bin/env python3
"""Fights played inside the real game, turned into match records the training pipeline reads:

    python3 lab/navrey_runs.py                 # every session and PvE track not converted yet
    python3 lab/navrey_runs.py --dry-run       # what would be written

Each fight Laya played through Navrey (an agent session's `fight` calls and the Guard's answers to
attacks in ~/UO/sessions/*/, the arena PvE track in ~/UO/pve/*/) becomes one run in runs/navrey/, in the
arena's format (bot/src/game/match.ts): one round, the fighters, the winner and every decision with its
whole state. bot/src/distill/outcomes.ts scores such runs as it scores the arena's, so fights against
monsters at a novice's skill can join the training data. They are kept apart from runs/ itself, so that
nothing learns from them until a recipe names the folder.

The fight's end comes from what the harness recorded (the `fight` tool's result, the Guard's record, the PvE
track's results.jsonl). Decisions made before melee-3 lack the fighter's skills and the creature's danger:
they are filled in from the template the session used (warrior-novice) and from the bestiary, as the game
path fills them now. Standard library only.
"""
import argparse
import glob
import json
import os
import time

import bestiary

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "runs", "navrey")
SESSIONS = os.path.expanduser("~/UO/sessions")
PVE = os.path.expanduser("~/UO/pve")
# templates/warrior-novice.json in the names Navrey's `skills` prints.
NOVICE = {"Swordsmanship": 50, "Tactics": 50, "Anatomy": 50, "Healing": 50, "Parrying": 30}
GAP_S = 30  # decisions further apart than this belong to different fights


def lines(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


def fights_of(rows):
    """Decision rows grouped into fights: the same target, no long pause."""
    groups = []
    for r in sorted(rows, key=lambda r: r["t"]):
        serial = (r.get("target") or {}).get("serial")
        last = groups[-1] if groups else None
        if last and last["serial"] == serial and r["t"] - last["rows"][-1]["t"] <= GAP_S * 1000:
            last["rows"].append(r)
        else:
            groups.append({"serial": serial, "rows": [r]})
    return groups


def endings_of_session(folder):
    """[(t in ms, serial, outcome)] from the `fight` tool's results and the Guard's records."""
    out = []
    for e in lines(os.path.join(folder, "agent.jsonl")):
        if e.get("kind") == "tool" and e.get("name") == "fight":
            result = (e.get("result") or "").strip().splitlines()[-1] if e.get("result") else ""
            serial = (e.get("args") or {}).get("target")
            if serial and ":" in result and not result.startswith("Not done"):
                out.append((e["t"] * 1000, serial.upper().replace("0X", "0x"), result.split(":", 1)[0]))
        elif e.get("kind") == "reflex" and e.get("serial"):
            out.append((e["t"] * 1000, e["serial"], (e.get("result") or "").split(":", 1)[0]))
    return out


def endings_of_pve(folder):
    """[(t in ms, None, outcome)] from the PvE track's results, one a round (its creature's serial is not kept)."""
    return [(r["t"] * 1000, None, r.get("outcome")) for r in lines(os.path.join(folder, "results.jsonl")) if r.get("outcome")]


def ending(group, endings):
    """The recorded end of a fight: the first ending after its last decision, for its target (any, on the PvE track)."""
    last = group["rows"][-1]["t"]
    for t, serial, outcome in sorted(endings):
        if t >= last - 1000 and (serial is None or serial == group["serial"]) and t - last <= 180_000:
            endings.remove((t, serial, outcome))
            return outcome
    return None


def fill(snapshot, beasts):
    """The fields melee-3 reads, where the decision was made before the game path filled them."""
    us, them = snapshot["us"], snapshot["them"]
    us.setdefault("skills", dict(NOVICE))
    if "creature" not in them:
        c = beasts.get(them.get("name", "").lower())
        if c:
            k = us["skills"]
            d = bestiary.danger(c, {"hits": max(1, us.get("hits") or 1), "swords": k.get("Swordsmanship", 50), "tactics": k.get("Tactics", 50),
                                    "anatomy": k.get("Anatomy", 50), "parry": k.get("Parrying", 0), "damage": 16, "swing": 3.75})
            them["creature"] = {"danger": bestiary.level(d["loss"]), "loss": d["loss"],
                                "attacksOnSight": c.get("fightMode") in ("Closest", "Evil"), "caster": c.get("ai") == "mage"}
    return snapshot


def run_of(group, outcome, source, beasts):
    rows = group["rows"]
    first = rows[0]
    me = first["snapshot"]["us"]["name"]
    them = (first.get("target") or {}).get("name") or first["snapshot"]["them"]["name"]
    winner = me if outcome == "won" else them if outcome == "died" else None
    records = []
    for i, r in enumerate(rows):
        records.append({
            "id": i + 1, "at": r["t"], "bot": me, "opponent": them,
            "decision": {"brain": "laya", "model": r.get("model"), "latencyMs": r.get("latencyMs", 0), "module": "melee",
                         "mode": r.get("mode"), "parts": r.get("parts"), "plan": r.get("plan"), "why": r.get("why"),
                         "tactics": r.get("tactics")},
            "snapshot": fill(r["snapshot"], beasts),
        })
    return {
        "versions": {"run": 3, "melee": first.get("format"), "models": {me: first.get("model")}, "where": {"instance": "navrey", "source": source}},
        "match": {"title": f"{me} (laya) vs {them}", "fighters": [{"name": me, "brain": "laya", "template": "warrior-novice",
                                                                   "tactics": first.get("tactics")}, {"name": them, "brain": "creature"}],
                  "round": 1, "rounds": 1, "results": [{"round": 1, "winner": winner, "outcome": outcome}]},
        "records": records,
    }


def convert(folder, pve, beasts, dry_run):
    # The first sessions (2026-10-13) kept a summary of each decision, not its whole state: nothing to learn from.
    rows = [r for r in lines(os.path.join(folder, "fights.jsonl")) if "snapshot" in r]
    endings = endings_of_pve(folder) if pve else endings_of_session(folder)
    written = unknown = 0
    for group in fights_of(rows):
        outcome = ending(group, endings)
        if outcome is None:
            unknown += 1
            continue
        stamp = time.strftime("%Y-%m-%dT%H-%M-%S", time.gmtime(group["rows"][0]["t"] / 1000)) + f"-{group['rows'][0]['t'] % 1000:03d}Z"
        path = os.path.join(OUT, f"navrey--{stamp}.json")
        if not dry_run:
            with open(path, "w") as f:
                json.dump(run_of(group, outcome, os.path.basename(folder), beasts), f)
        written += 1
    return written, unknown


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--again", action="store_true", help="convert folders done before too")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    done_path = os.path.join(OUT, "converted.list")
    done = set(json.load(open(done_path))) if os.path.exists(done_path) and not args.again else set()
    with open(os.path.join(ROOT, "data", "bestiary.json")) as f:
        beasts = {c["name"].lower(): c for c in json.load(f).values()}
    folders = [(p, False) for p in sorted(glob.glob(os.path.join(SESSIONS, "*")))] + [(p, True) for p in sorted(glob.glob(os.path.join(PVE, "*")))]
    total = 0
    for folder, pve in folders:
        name = os.path.basename(folder)
        if name in done or not os.path.exists(os.path.join(folder, "fights.jsonl")):
            continue
        # A session still recording is left for the next time.
        if time.time() - os.path.getmtime(os.path.join(folder, "fights.jsonl")) < 120:
            continue
        written, unknown = convert(folder, pve, beasts, args.dry_run)
        total += written
        print(f"{name}: {written} fights{f', {unknown} without a recorded end' if unknown else ''}")
        done.add(name)
    if not args.dry_run:
        with open(done_path, "w") as f:
            json.dump(sorted(done), f, indent=0)
    print(f"{total} fights {'would be written' if args.dry_run else 'written'} to {OUT}")


if __name__ == "__main__":
    main()
