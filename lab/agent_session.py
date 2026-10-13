#!/usr/bin/env python3
"""Runs a large model as a player through Navrey for a while and records what it did and saw:

    python3 lab/agent_session.py fable --minutes 30
    python3 lab/agent_session.py qwen --minutes 30 --model ollama/qwen3.8:27b

The client must already be running and in the world (Navrey's cli/navrey, ~/Projects/navrey). The
player is Claude Code with a Claude model ("fable": claude-fable-5-1), or opencode with a local
model ("qwen" and the like, through Ollama), started in the Navrey checkout so that it reads its
CLAUDE.md and skills. The run is stopped at the time limit.

Everything lands in ~/UO/sessions/<stamp>-<player>/:
- agent.jsonl: the player's own transcript (what it thought, the commands it ran, their output);
- state.jsonl: Navrey's /tmp/cuostate.json every 2 s, with the time;
- world.jsonl: /tmp/cuoworld.json (mobiles and items nearby) every 5 s;
- cuolog.txt: the client's command log, copied at the end.

These are the raw material for teaching small models the slow decisions (where to go, what to fight,
when to run, heal, restock or bank). Standard library only.
"""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time

NAVREY = os.path.expanduser("~/Projects/navrey")
SESSIONS = os.path.expanduser("~/UO/sessions")

PROMPT = """You are playing Ultima Online yourself, as a player would, on a private test shard of ours
(ModernUO, Mondain's Legacy rules). Nobody else is online. Your character {name} is a young swordsman
with leather armour, a shield, bandages, three heal potions and 1,000 gold. The client is already
running and logged in: drive it with Navrey's commands as CLAUDE.md and the skills in .claude/skills
describe (append commands to /tmp/cuocmd, read /tmp/cuolog, /tmp/cuostate.json and /tmp/cuoworld.json).
Do not start, stop or restart the client.

Play however you like for about {minutes} minutes: look around, hunt what you can beat, heal, loot,
restock, bank, explore. Before every decision that matters (where to go, what to fight, when to run,
heal, restock or bank), write one short line starting with "DECISION:" saying what you chose and why.
Do not edit or create files."""

# What the Claude player may run: Navrey's front end and the shell tools its skills use, and nothing else.
CLAUDE_TOOLS = [
    "Bash(cli/navrey:*)", "Bash(printf:*)", "Bash(echo:*)", "Bash(tail:*)", "Bash(cat:*)", "Bash(jq:*)",
    "Bash(sleep:*)", "Bash(grep:*)", "Bash(head:*)", "Bash(python3 .claude/skills:*)", "Read", "Grep", "Glob",
]


def snapshots(path_in, path_out, every, stop):
    with open(path_out, "a") as out:
        while not stop.is_set():
            try:
                with open(path_in) as f:
                    data = json.load(f)
                out.write(json.dumps({"t": time.time(), "state": data}) + "\n")
                out.flush()
            except (OSError, ValueError):
                pass  # being rewritten; next time
            stop.wait(every)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("player", help="fable, or a name for a local model's run")
    ap.add_argument("--minutes", type=float, default=30)
    ap.add_argument("--name", default=None, help="the character's name (default: the player's, capitalised)")
    ap.add_argument("--model", default=None, help="opencode's provider/model for a local player (ollama/qwen3.8:27b)")
    args = ap.parse_args()

    stamp = time.strftime("%Y-%m-%dT%H-%M")
    folder = os.path.join(SESSIONS, f"{stamp}-{args.player}")
    os.makedirs(folder, exist_ok=True)
    prompt = PROMPT.format(name=args.name or args.player.capitalize(), minutes=int(args.minutes))
    if args.player == "fable":
        cmd = ["claude", "-p", prompt, "--model", "claude-fable-5-1", "--output-format", "stream-json", "--verbose",
               "--allowedTools", *CLAUDE_TOOLS]
    else:
        if not args.model:
            sys.exit("a local player needs --model (opencode's provider/model)")
        # Permissions come from Navrey's opencode.json: Navrey's commands and read-only tools only, edits denied.
        cmd = ["opencode", "run", "--model", args.model, "--format", "json", "--auto", prompt]
    with open(os.path.join(folder, "run.json"), "w") as f:
        json.dump({"player": args.player, "model": args.model or "claude-fable-5-1", "minutes": args.minutes,
                   "started": time.time(), "prompt": prompt, "command": cmd[:1] + cmd[2:3]}, f, indent=1)

    stop = threading.Event()
    threads = [threading.Thread(target=snapshots, args=("/tmp/cuostate.json", os.path.join(folder, "state.jsonl"), 2, stop), daemon=True),
               threading.Thread(target=snapshots, args=("/tmp/cuoworld.json", os.path.join(folder, "world.jsonl"), 5, stop), daemon=True)]
    for t in threads:
        t.start()
    log_start = os.path.getsize("/tmp/cuolog") if os.path.exists("/tmp/cuolog") else 0
    print(f"{time.strftime('%H:%M')} {args.player} plays for {args.minutes:g} min; recording into {folder}", flush=True)
    with open(os.path.join(folder, "agent.jsonl"), "w") as out:
        proc = subprocess.Popen(cmd, cwd=NAVREY, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            proc.wait(timeout=args.minutes * 60)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
    stop.set()
    for t in threads:
        t.join(timeout=10)
    if os.path.exists("/tmp/cuolog"):
        with open("/tmp/cuolog", "rb") as f, open(os.path.join(folder, "cuolog.txt"), "wb") as out:
            f.seek(log_start)
            shutil.copyfileobj(f, out)
    print(f"{time.strftime('%H:%M')} {args.player} done (exit {proc.returncode}); {folder}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
