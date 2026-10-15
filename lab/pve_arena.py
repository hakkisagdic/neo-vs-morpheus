#!/usr/bin/env python3
"""The arena PvE track: Laya fights one creature at a time inside the real game, through Navrey, every
round set up the same way, so that its fighting against monsters can be measured and improved:

    python3 lab/pve_arena.py                                   # the default creatures, 3 tactics, 2 rounds
    python3 lab/pve_arena.py --creatures TimberWolf,Harpy --tactics cautious --rounds 5

Each round the GM clears the arena (NeoClear), refits the fighter as a young swordsman and puts it on
the west side (NeoTemplate, NeoPlace), and spawns the creature 8 tiles east (NeoMage); then `npm run
nvm -- fight` lets Laya fight it to the end. The creatures run from harmless to deadly by the bestiary
(lab/bestiary.py), whose predicted danger is kept beside each result, so that the prediction can be
checked too. Everything goes to ~/UO/pve/<stamp>/: results.jsonl (one round a line), fights.jsonl (Laya's
decisions with whole states), session.mp4 (the game's own frames) and summary.txt. The Navrey client
and the agent's Laya server (--laya) must be running. Standard library only.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

import bestiary
import uo_agent

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.expanduser("~/UO/pve")
# From harmless to deadly for the young swordsman (lab/bestiary.py's estimate).
CREATURES = ["Rat", "Zombie", "Skeleton", "TimberWolf", "BlackBear", "Cougar", "Bull", "Harpy", "GrizzlyBear", "OrcishMage", "Troll"]


def gm(*commands, wait=2):
    done = subprocess.run(["bash", os.path.join(ROOT, "lab", "world.sh"), "gm", "--wait", str(wait), "--settle", "400", *commands],
                          capture_output=True, text=True, timeout=300)
    return done.stdout + done.stderr


def visible(serial, timeout=15):
    """Waits until Navrey sees the creature; its mobile, or None."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for m in uo_agent.read_json(uo_agent.WORLD).get("mobiles", []):
            if int(m["serial"], 16) == serial:
                return m
        time.sleep(0.5)
    return None


def round_(name, kind, tactics, laya, folder, max_seconds):
    reply = gm("[NeoClear 30", f"[NeoTemplate {name} warrior-novice", f"[NeoPlace {name} west 8", f"[NeoMage {kind} 8")
    spawned = re.search(r"NEO mage (.+?) 0x([0-9A-F]{8})", reply)
    if not spawned:
        return {"outcome": "no spawn", "reply": reply.strip()[-300:]}
    serial = int(spawned.group(2), 16)
    if not visible(serial):
        return {"outcome": "not seen", "creature": spawned.group(1)}
    done = subprocess.run(["npm", "run", "-s", "nvm", "--", "fight", f"0x{serial:08X}", "--tactics", tactics, "--max", str(max_seconds),
                           "--record", os.path.join(folder, "fights.jsonl"), "--json"],
                          cwd=os.path.join(ROOT, "bot"), env=dict(os.environ, LAYA_URL=laya), capture_output=True, text=True,
                          timeout=max_seconds + 120)
    lines = [l for l in done.stdout.splitlines() if l.startswith("{")]
    return json.loads(lines[-1]) if lines else {"outcome": "error", "error": (done.stdout + done.stderr).strip()[-300:]}


def summary(rows):
    by = {}
    for r in rows:
        by.setdefault((r["creature"], r["tactics"]), []).append(r)
    out = [f"{'creature':12} {'tactics':10} {'won':>5} {'died':>5} {'fled':>5} {'other':>6} {'hits left (won)':>16} {'predicted loss':>15}"]
    for (kind, tactics), rs in sorted(by.items(), key=lambda kv: (CREATURES.index(kv[0][0]) if kv[0][0] in CREATURES else 99, kv[0][1])):
        n = lambda o: sum(1 for r in rs if r["outcome"] == o)
        won = [r for r in rs if r["outcome"] == "won" and r.get("maxHits")]
        left = f"{round(100 * sum(r['hits'] / r['maxHits'] for r in won) / len(won))}%" if won else "-"
        other = len(rs) - n("won") - n("died") - n("fled")
        out.append(f"{kind:12} {tactics:10} {n('won'):>5} {n('died'):>5} {n('fled'):>5} {other:>6} {left:>16} {rs[0].get('predicted', '?'):>15}")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", default="Gemma", help="the character Navrey plays")
    ap.add_argument("--creatures", default=",".join(CREATURES), help="ModernUO creature types, comma separated")
    ap.add_argument("--tactics", default="cautious,balanced,aggressive")
    ap.add_argument("--rounds", type=int, default=2, help="rounds for each creature and tactics")
    ap.add_argument("--laya", default="http://127.0.0.1:8100", help="the agent's Laya server")
    ap.add_argument("--max", type=int, default=120, help="seconds a fight may last")
    ap.add_argument("--video", type=float, default=2, help="frames a second for session.mp4 (0: none)")
    args = ap.parse_args()

    folder = os.path.join(OUT, time.strftime("%Y-%m-%dT%H-%M"))
    os.makedirs(folder, exist_ok=True)
    beasts = {c["type"]: c for c in json.load(open(os.path.join(ROOT, "data", "bestiary.json"))).values()}
    me = dict(uo_agent.FIGHTER, hits=85)
    kinds = [k.strip() for k in args.creatures.split(",") if k.strip()]
    unknown = [k for k in kinds if k not in beasts]
    if unknown:
        sys.exit(f"not in the bestiary: {', '.join(unknown)}")
    if args.video:
        print(uo_agent.command(f"record {os.path.join(folder, 'session.mp4')} {args.video:g}", harness=True), flush=True)
    rows = []
    try:
        with open(os.path.join(folder, "results.jsonl"), "a") as out:
            for r in range(args.rounds):
                for kind in kinds:
                    for tactics in [t.strip() for t in args.tactics.split(",")]:
                        d = bestiary.danger(beasts[kind], me)
                        res = round_(args.name, kind, tactics, args.laya, folder, args.max)
                        row = {"t": time.time(), "round": r, "creature": kind, "tactics": tactics,
                               "predicted": f"{bestiary.level(d['loss'])} {round(100 * d['loss'])}%", **res}
                        rows.append(row)
                        out.write(json.dumps(row) + "\n")
                        out.flush()
                        print(f"{time.strftime('%H:%M')} {kind} ({tactics}): {res.get('outcome')} in {res.get('seconds', '?')} s, "
                              f"hits {res.get('hits', '?')}/{res.get('maxHits', '?')}", flush=True)
    finally:
        if args.video:
            print(uo_agent.command("record stop", harness=True, timeout=120), flush=True)
        # Nobody left behind: the arena cleared, the fighter alive, refitted and back in New Haven.
        gm("[NeoClear 30", f"[NeoPrep {args.name}", f"[NeoTemplate {args.name} warrior-novice",
           f'[Global Set Location "(3503, 2574, 14)" where PlayerMobile Name = {args.name}',
           f"[Global Set Map Trammel where PlayerMobile Name = {args.name}")
        text = summary(rows)
        with open(os.path.join(folder, "summary.txt"), "w") as f:
            f.write(text + "\n")
        print(text)
        print(folder)


if __name__ == "__main__":
    main()
