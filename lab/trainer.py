#!/usr/bin/env python3
"""Keeps Kaggle training Laya without a break, one round every 10 minutes:

    python3 lab/trainer.py            # until stopped
    python3 lab/trainer.py --once     # one round

1. A training kernel that finished is fetched (training/kaggle.py fetch), published to the private
   model repo, and put on one of this Mac's candidate lanes against the scripted bot at matched
   speed (lab/evaluate.py), replacing the older candidate there.
   Once a candidate and the champion have each played 400 mage-duel rounds since the candidate
   came, a one-sided two-proportion z-test (95%) promotes it (the champion's lanes become its) or
   drops it (its lane goes back to the champion). While FreeJev credits last, Jev labels the
   champion's own states from its clean runs, a mage batch and then a melee one (DAgger with Jev as
   the expert), and the next versions are built with those labels.
2. While fewer than two of the account's GPU sessions run (Kaggle's limit) and the weekly quota has
   room for a training, the next version goes up, two at a time when two wait (a kernel has two
   T4s, so both train in one session): the runs played since the last labeling become
   outcome rows (distill outcomes), the newest set plus those rows becomes the next set
   (build_set.py), and training/kaggle.py starts it. No DAgger rows: the scripted bot's labels made
   neo-duel-v8-dagger-all worse in every build.

recipe "seeds" trains the champion's own set (state "set") again with two fresh seeds per session:
the seed alone moved a model ten points live, and the gate keeps the best.

recipe "jev" instead builds each version from a fixed base set (state "set") plus the Jev label
files in extra, once 1,000 new labels have come: outcome rows made v9a lose to v8 (47% against
62% in the mage duel), so the jev recipe adds none.

State lives in .fleet/trainer.json: the recipe, the next version number, the newest (or base) set,
label files every version keeps (extra), when runs were last labeled, versions built but not pushed (queue), pushed but
not fetched (pushed), and which candidate plays on which lane. Edit it between rounds to change the
plan. Standard library only.
"""
import argparse
import datetime
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BOT = os.path.join(ROOT, "bot")
PY = os.path.join(ROOT, ".laya", "venv", "bin", "python")
STATE = os.path.join(ROOT, ".fleet", "trainer.json")
DATA = os.path.join("training", "data")
#: A training this size or smaller is not worth a slot; wait for more runs.
MIN_NEW_ROWS = 3000
#: New Jev labels a "jev" version needs over the last one.
MIN_NEW_JEV = 1000
#: Mage-duel rounds each side needs before a candidate is promoted or dropped, and the one-sided
#: z for 95% confidence; the scripted bot at this reaction time or quicker is "matched speed".
#: Rounds each side plays before the gate decides, once: looking again and again as rounds come in
#: would raise its error well past the stated 5% (an adversarial review measured 18% over 3 hours).
GATE_ROUNDS = 800
#: The rounds of a run share its arena and seats: the variance of a share is ~1.25-1.36 times the
#: binomial one in the gate's runs, so the standard error is widened by its root.
GATE_VIF = 1.3
#: Agreement with the oracle trainer on sampled training states that counts as "can train skills".
SKILL_AGREEMENT = 0.8
GATE_Z = 1.645
#: Points a candidate that can train skills may trail a champion that cannot, at duels (non-inferiority).
SKILL_MARGIN = 0.05
MATCHED_MS = 60
#: States asked of Jev per labeling batch, and the credits below which labeling waits.
LABEL_BATCH = 2000
MIN_CREDITS = 300
LABELER_PID = os.path.join(ROOT, ".fleet", "train", "labeler.pid")
#: Downloads of a finished kernel's output tried before a version counts as failed.
FETCH_TRIES = 3
#: Hours of weekly GPU quota a training session needs (v8's 16k-row set, two seeds: 1.5 h on the T4s).
QUOTA_HOURS = 2.0
#: What a session under way is expected to take from the quota still.
SESSION_HOURS = 1.6
#: Runs still playing when runs are labeled are picked up next time: the next labeling starts this much earlier.
OVERLAP = datetime.timedelta(minutes=30)


def log(message):
    print(f"{time.strftime('%H:%M')} {message}", flush=True)


def sh(cmd, cwd=ROOT, timeout=7200):
    """A command's exit code and output; one that runs past its timeout answers 124, like timeout(1)."""
    try:
        out = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as err:
        return 124, f"{' '.join(map(str, cmd))[:120]}: no answer in {timeout} s; {(err.stdout or '')[-200:]}"
    return out.returncode, (out.stdout + out.stderr).strip()


def load():
    with open(STATE) as f:
        return json.load(f)


def save(state):
    with open(f"{STATE}.tmp", "w") as f:
        json.dump(state, f, indent=1)
    os.replace(f"{STATE}.tmp", STATE)


def stamp(at):
    """A run file's time stamp format, so that `distill outcomes <since>` compares like with like."""
    return at.strftime("%Y-%m-%dT%H-%M")


def sessions():
    """The account's GPU kernels that ran lately, by name, with their state."""
    code, csv = sh(["kaggle", "kernels", "list", "--mine", "--page-size", "20", "--csv"], timeout=120)
    states = {}
    if code:
        return None
    for line in csv.splitlines()[1:]:
        ref, *_rest = line.split(",")
        at = line.split(",")[3] if len(line.split(",")) > 3 else ""
        try:
            if datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(f"{at.replace(' ', 'T')}+00:00") > datetime.timedelta(hours=14):
                continue
        except ValueError:
            continue
        _, out = sh(["kaggle", "kernels", "status", ref], timeout=120)
        m = re.search(r'status "?(?:KernelWorkerStatus\.)?(\w+)', out)
        states[ref.split("/")[1]] = m.group(1).lower() if m else "unknown"
    return states


def quota_left():
    code, out = sh(["kaggle", "quota"], timeout=120)
    m = re.search(r"^GPU\s+[\d.]+h\s+([\d.]+)h", out, re.M)
    return float(m.group(1)) if m and not code else None


def kernel(state, name):
    """The kernel that trains a version: its own, or the one it shares with its pair."""
    return state.get("kernels", {}).get(name, f"{name}-train")


def track(*names):
    """Records versions in the MLflow experiment (lab/track.py, in its own .mlflow environment)."""
    py = os.path.join(ROOT, ".mlflow", "bin", "python")
    if os.path.exists(py):
        code, out = sh([py, "lab/track.py", "sync", *names], timeout=600)
        if code:
            log(f"MLflow record failed: {out[-200:]}")


def fetch(state, name):
    code, out = sh([sys.executable, "training/kaggle.py", "fetch", "--name", name, "--kernel", kernel(state, name)])
    log(f"{name}: fetched" if not code else f"{name}: fetch failed: {out[-300:]}")
    # The training's own lines (each epoch's held-out agreement), for the experiment record.
    os.makedirs(os.path.join(ROOT, ".fleet", "kaggle-logs"), exist_ok=True)
    with open(os.path.join(ROOT, ".fleet", "kaggle-logs", f"{name}.log"), "w") as f:
        f.write(out)
    if code:
        # A broken download is tried again next round; an output without the checkpoint is final.
        return False if "no checkpoint" in out else None
    code, out = sh([PY, "training/publish_hf.py", "model", os.path.join("training", "checkpoints", name), "--tag", name, "--card", "docs/hf/laya-neo-duel.md"])
    log(f"{name}: published" if not code else f"{name}: publish failed (kept here): {out[-200:]}")
    return True


def evaluate(state, name):
    """The new checkpoint takes the candidate lane that holds the older candidate."""
    candidates = state.setdefault("candidates", {})
    order = state.setdefault("arrived", [])
    # The champion must keep a lane to play on: its last one is not given to a candidate.
    with open(os.path.join(ROOT, ".fleet", "plan.json")) as f:
        champion_lanes = [l["lane"] for l in json.load(f).get("mac", []) if l.get("model") == state.get("champion")]
    lanes = [l for l in state.get("eval_lanes", [0, 2]) if not (champion_lanes == [l] and str(l) not in candidates)]
    free = [l for l in lanes if str(l) not in candidates]
    lane = free[0] if free else min(lanes, key=lambda l: order.index(candidates[str(l)]) if candidates[str(l)] in order else -1)
    if str(lane) in candidates:
        # The older candidate leaves before its verdict: keep what it had played.
        old = candidates[str(lane)]
        results = duel_results(state.get("eval_since", {}).get(old, ""))
        (w, l), (bw, bl) = results.get(old, (0, 0)), results.get(state.get("champion", "neo-duel-v8"), (0, 0))
        enough = min(w + l, bw + bl) >= GATE_ROUNDS
        state.setdefault("history", []).append({"replaced": old, "at": state.get("eval_since", {}).get(old),
            "result": f"{old} {100 * w / max(1, w + l):.0f}% ({w}-{l}) against {state.get('champion')} {100 * bw / max(1, bw + bl):.0f}% ({bw}-{bl}), "
                      + ("replaced undecided" if enough else f"replaced before {GATE_ROUNDS} rounds")})
    code, out = sh([sys.executable, "lab/evaluate.py", "--model", name, "--lane", str(lane)])
    log(f"{name}: evaluating on lane {lane}" if not code else f"{name}: evaluation start failed: {out[-300:]}")
    candidates[str(lane)] = name
    order.append(name)
    state.setdefault("eval_since", {})[name] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def duel_results(since):
    """Mage-duel round wins and losses against the scripted bot at matched speed (rules@60 or quicker)
    on this Mac since a time, by checkpoint, its own play only (no tactics profile)."""
    # Benchmark runs stay out: a bench score must come from rounds no selection has seen.
    code, out = sh(["npm", "run", "-s", "nvm", "--", "fleet", "results", "--since", since, "--instance", "mac", "--no-bench"], cwd=BOT, timeout=900)
    results = {}
    for m in re.finditer(r"^(neo-\S+) mage vs rules@(\d+) mage: (\d+)-(\d+)", out, re.M):
        if int(m.group(2)) <= MATCHED_MS:
            wins, losses = results.get(m.group(1), (0, 0))
            results[m.group(1)] = (wins + int(m.group(3)), losses + int(m.group(4)))
    return results


def switch_lanes(old, new):
    """Every Mac lane the plan gives to `old` plays `new` from now on, on the same series."""
    with open(os.path.join(ROOT, ".fleet", "plan.json")) as f:
        lanes = [l for l in json.load(f).get("mac", []) if l.get("model") == old]
    for lane in lanes:
        sh([sys.executable, "lab/evaluate.py", "--model", new, "--lane", str(lane["lane"]), "--series", lane["series"]])
    return [l["lane"] for l in lanes]


def gate(state):
    """Each candidate against the champion over the same hours: once both have GATE_ROUNDS mage-duel
    rounds, one one-sided two-proportion z-test (unpooled, widened by GATE_VIF) promotes a better
    candidate, or one no worse by the margin when it brings skill training (its lanes and the
    champion's become its), and otherwise drops it (its lane goes back to the champion). At most
    one promotion a pass: the rest were measured against the old champion."""
    champion = state.setdefault("champion", "neo-duel-v8")
    for lane, name in list(state.get("candidates", {}).items()):
        since = state.get("eval_since", {}).get(name)
        if not since or name == champion:
            continue
        skilled = state.get("skills", [])
        if champion in skilled and name not in skilled:
            # The champion trains skills too; a version that cannot would lose that, however it duels.
            sh([sys.executable, "lab/evaluate.py", "--model", champion, "--lane", lane])
            state.setdefault("history", []).append({"dropped": name, "at": since, "result": f"{name} cannot train skills; {champion} can"})
            del state["candidates"][lane]
            log(f"dropped: {name} cannot train skills; lane {lane} plays {champion} again")
            track(name)
            save(state)
            continue
        results = duel_results(since)
        (cw, cl), (bw, bl) = results.get(name, (0, 0)), results.get(champion, (0, 0))
        n1, n2 = cw + cl, bw + bl
        if n1 < GATE_ROUNDS or n2 < GATE_ROUNDS:
            log(f"{name} against {champion}: {cw}-{cl} and {bw}-{bl}; waiting for {GATE_ROUNDS} rounds each")
            continue
        # One look, at GATE_ROUNDS: the unpooled standard error, widened for rounds that go together.
        p1, p2 = cw / n1, bw / n2
        se = math.sqrt(GATE_VIF * (p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2)) or 1.0
        # A candidate that brings something new (skill training) needs only to be no worse at duels:
        # a non-inferiority test, its share plus the margin against the champion's. The margin needs
        # evidence that it does train skills: agreement with the oracle on sampled training states.
        margin = state.get("margins", {}).get(name, 0.0)
        if not margin and name in skilled and champion not in skilled:
            agreement = skill_agreement(state, name, lane)
            margin = SKILL_MARGIN if agreement is not None and agreement >= SKILL_AGREEMENT else 0.0
        z = (p1 - p2 + margin) / se
        verdict = (f"{name} {100 * p1:.0f}% ({cw}-{cl}) against {champion} {100 * p2:.0f}% ({bw}-{bl}), z {z:+.2f}"
                   + (f" (no worse by {100 * margin:.0f} points)" if margin else ""))
        if z > GATE_Z:
            moved = switch_lanes(champion, name)
            state["champion"] = name
            state.setdefault("label_since", {})[name] = since[:16].replace(":", "-")
            state.setdefault("history", []).append({"promoted": name, "over": champion, "at": since, "result": verdict})
            del state["candidates"][lane]
            log(f"promoted: {verdict}; lanes {moved} now play it")
            track(name, champion)
            # The other candidates were measured against the old champion: they wait for the next pass.
            save(state)
            return
        # Not shown better (or no worse): it leaves at its one look, and its lane plays the champion again.
        sh([sys.executable, "lab/evaluate.py", "--model", champion, "--lane", lane])
        state.setdefault("history", []).append({"dropped": name, "at": since, "result": verdict})
        del state["candidates"][lane]
        log(f"dropped: {verdict}; lane {lane} plays {champion} again")
        track(name)
        save(state)


def skill_agreement(state, name, lane):
    """How often the candidate (its Laya server on lane's port) picks what the oracle trainer picks on
    sampled training states; measured once, kept in the state. None when it cannot be measured."""
    known = state.setdefault("skillcheck", {})
    if name in known:
        return known[name]
    code, out = sh(["npm", "run", "-s", "nvm", "--", "skillcheck", f"http://127.0.0.1:{8001 + int(lane)}", "200"], cwd=BOT, timeout=1800)
    m = re.search(r"agreement ([\d.]+)", out)
    if code or not m:
        log(f"{name}: skill check failed: {out[-200:]}")
        return None
    known[name] = float(m.group(1))
    log(f"{name}: agrees with the oracle trainer on {100 * known[name]:.0f}% of training states")
    return known[name]


def build_jev(state):
    """recipe "jev": a base set plus every label file in extra (Jev's answers on Laya's own states),
    once those have grown by MIN_NEW_JEV rows since the last version. With variants, one version per
    base ({"suffix": "p", "base": ...}), built together so that they share a session's two GPUs."""
    n = state["next"]
    extra = [f for f in state.get("extra", []) if os.path.exists(os.path.join(ROOT, f))]
    total = 0
    for f in extra:
        with open(os.path.join(ROOT, f)) as fh:
            total += sum(1 for line in fh if line.strip())
    if total - state.get("extra_rows", 0) < MIN_NEW_JEV:
        log(f"{total - state.get('extra_rows', 0)} new Jev labels since the last version; waiting for {MIN_NEW_JEV}")
        return []
    jobs = []
    for variant in state.get("variants") or [{"suffix": "", "base": state["set"]}]:
        name = f"neo-duel-v{n}{variant['suffix']}"
        data = os.path.join(DATA, f"train-v{n}{variant['suffix']}.jsonl")
        code, out = sh(["nice", "-n", "19", sys.executable, "training/build_set.py", "--out", data, variant["base"], *extra])
        if code:
            log(f"building {data} failed: {out[-300:]}")
            continue
        log(f"{name}: {out.splitlines()[-2].strip() if len(out.splitlines()) > 1 else out}")
        jobs.append({"name": name, "data": data})
    if jobs:
        state.update(next=n + 1, extra_rows=total)
    return jobs


def build_seeds(state):
    """recipe "seeds": the champion's own training set again with two fresh seeds (a session's two
    GPUs). The seed alone moved a model by ten points live; the gate keeps the best."""
    seed = state.get("next_seed", 5)
    prefix = state.get("seed_prefix", "neo-duel-v8s")
    state["next_seed"] = seed + 2
    log(f"{prefix}{seed} and {prefix}{seed + 1}: {state['set']} with seeds {seed} and {seed + 1}")
    jobs = [{"name": f"{prefix}{s}", "data": state["set"], "args": ["--seed", str(s)]} for s in (seed, seed + 1)]
    if state.get("set_trains_skills"):
        state.setdefault("skills", []).extend(j["name"] for j in jobs)
    return jobs


def build_next(state):
    """Labels the runs since the last labeling and builds the next version's set onto the newest one."""
    if state.get("recipe") == "seeds":
        return build_seeds(state)
    if state.get("recipe") == "jev":
        return build_jev(state)
    return [job] if (job := build_outcomes(state)) else []


def build_outcomes(state):
    """recipe "outcomes": labels the runs since the last labeling and adds them to the newest set."""
    n = state["next"]
    name = f"neo-duel-v{n}"
    now = datetime.datetime.now(datetime.timezone.utc)
    code, out = sh(["nice", "-n", "19", "npm", "run", "-s", "nvm", "--", "distill", "outcomes", state["labeled_until"]], cwd=BOT)
    if code:
        log(f"labeling failed: {out[-300:]}")
        return None
    rows = os.path.join(DATA, f"labeled-outcome-v{n}.jsonl")
    shutil.copyfile(os.path.join(ROOT, DATA, "labeled-outcome.jsonl"), os.path.join(ROOT, rows))
    with open(os.path.join(ROOT, rows)) as f:
        new = sum(1 for line in f if line.strip())
    if new < MIN_NEW_ROWS:
        log(f"only {new} new outcome rows since {state['labeled_until']}; waiting for more runs")
        return None
    data = os.path.join(DATA, f"train-v{n}.jsonl")
    # Label files every version keeps (Jev's answers on Laya's own states, say), where they exist yet.
    extra = [f for f in state.get("extra", []) if os.path.exists(os.path.join(ROOT, f))]
    code, out = sh(["nice", "-n", "19", sys.executable, "training/build_set.py", "--out", data, state["set"], *extra, rows])
    if code:
        log(f"building {data} failed: {out[-300:]}")
        return None
    log(f"{name}: {out.splitlines()[-2].strip() if len(out.splitlines()) > 1 else out}")
    state.update(next=n + 1, set=data, labeled_until=stamp(now - OVERLAP))
    return {"name": name, "data": data}


def labeler_running():
    """The labeler this loop started is still at work (a pid file, so a restarted loop knows too)."""
    try:
        with open(LABELER_PID) as f:
            os.kill(int(f.read().strip()), 0)
        return True
    except (OSError, ValueError):
        return False


def label(state):
    """Keeps FreeJev answering the champion's own states while credits last, a mage batch and then a
    melee one, from the champion's clean runs since it took over (DAgger with Jev as the expert)."""
    if state.get("recipe") != "jev" or labeler_running():
        return
    code, out = sh(["npm", "run", "-s", "nvm", "--", "distill", "credits"], cwd=BOT, timeout=120)
    try:
        credits = float(out.strip().splitlines()[-1])
    except (ValueError, IndexError):
        log(f"FreeJev credits unknown: {out[-200:]}")
        return
    if credits < MIN_CREDITS:
        log(f"{credits:.0f} FreeJev credits left: labeling waits for a top-up")
        return
    champion = state.get("champion", "neo-duel-v8")
    module = state.get("label_next", "mage")
    since = state.setdefault("label_since", {}).setdefault(champion, "2026-10-05T13-50")
    melee = ["--module", "melee"] if module == "melee" else []
    code, out = sh(["nice", "-n", "19", "npm", "run", "-s", "nvm", "--", "distill", "states", str(LABEL_BATCH), "--set", "laya",
                    "--since", since, "--model", champion, *melee], cwd=BOT)
    if code:
        log(f"states for {champion} failed: {out[-300:]}")
        return
    logfile = open(os.path.join(ROOT, ".fleet", "train", f"freejev-{'melee-' if melee else ''}laya.log"), "a")
    proc = subprocess.Popen(["npm", "run", "-s", "nvm", "--", "distill", "label", str(LABEL_BATCH), "--set", "laya", *melee],
                            cwd=BOT, stdout=logfile, stderr=subprocess.STDOUT, start_new_session=True)
    with open(LABELER_PID, "w") as f:
        f.write(str(proc.pid))
    state["label_next"] = "mage" if melee else "melee"
    log(f"labeling {champion}'s {module} states with Jev ({credits:.0f} credits left): {out.splitlines()[-1] if out else ''}")
    save(state)


def read_inbox(state):
    """Orders left in .fleet/trainer-inbox.json between rounds, applied once and then removed, so that
    nothing edits the state while a round has it: {"candidates": [{"name": N, "margin": 0.05}],
    "set": PATH, "queue": [...], "seed_prefix": P, "next_seed": N, "skills": [names that train skills],
    "eval_lanes": [Mac lanes for candidates]}."""
    path = os.path.join(ROOT, ".fleet", "trainer-inbox.json")
    if not os.path.exists(path):
        return
    try:
        with open(path) as f:
            orders = json.load(f)
    except ValueError as err:
        os.replace(path, path + ".bad")  # set aside, so that one bad file does not stop every round
        log(f"inbox: unreadable ({err}); kept as {path}.bad")
        return
    for name in orders.get("skills", []):
        if name not in state.setdefault("skills", []):
            state["skills"].append(name)
            log(f"inbox: {name} trains skills")
    for key in ("set", "set_trains_skills", "queue", "seed_prefix", "next_seed", "recipe", "train_args", "eval_lanes"):
        if key in orders:
            state[key] = orders[key]
            log(f"inbox: {key} = {json.dumps(orders[key])[:200]}")
    for c in orders.get("candidates", []):
        if c.get("margin"):
            state.setdefault("margins", {})[c["name"]] = c["margin"]
        evaluate(state, c["name"])
        log(f"inbox: {c['name']} is a candidate" + (f", no worse by {100 * c['margin']:.0f} points" if c.get("margin") else ""))
    save(state)
    os.remove(path)  # only once the orders are in the saved state


def round_once():
    state = load()
    read_inbox(state)
    kernels = sessions()
    if kernels is None:
        # Kaggle is out of reach (or its login ran out): the Mac's own steps still run.
        log("the Kaggle CLI did not answer (logged out?); only the gate and labeling this round")
        gate(state)
        label(state)
        return
    # 1. Finished trainings come home and go on the lanes.
    for name in list(state.get("pushed", [])):
        st = kernels.get(kernel(state, name), "unknown")
        if st == "complete":
            fetched = fetch(state, name)
            tries = state.setdefault("fetch_tries", {})
            tries[name] = tries.get(name, 0) + 1
            if fetched:
                state["pushed"].remove(name)
                evaluate(state, name)
            elif fetched is False or tries[name] >= FETCH_TRIES:
                # No checkpoint in the output (its run failed in a pair's kernel), or the download kept breaking.
                state["pushed"].remove(name)
                state.setdefault("failed", []).append(name)
            track(name)
        elif st == "error" or st.startswith("cancel"):  # Kaggle says CANCEL_ACKNOWLEDGED
            log(f"{name}: the kernel ended with {st}; left out")
            state["pushed"].remove(name)
            state.setdefault("failed", []).append(name)
        save(state)
    # 2. Candidates that played enough rounds are promoted or dropped; Jev labels the champion's states.
    # Either can fail on a loaded Mac (reading the results timed out once); the GPUs must not wait for them.
    for step in (gate, label):
        try:
            step(state)
        except Exception as err:
            log(f"{step.__name__} failed this round: {err!r}")
            state = load()
    # 3. A free GPU session trains the next version.
    busy = sum(1 for s in kernels.values() if s in ("running", "queued"))
    left = quota_left()
    # The quota counts hours already used: a session running or waiting will take more of it.
    projected = None if left is None else left - SESSION_HOURS * busy
    if busy >= 2:
        log(f"both GPU sessions busy ({', '.join(k for k, s in kernels.items() if s in ('running', 'queued'))})")
    elif projected is not None and projected < QUOTA_HOURS:
        log(f"{left:.1f} GPU hours left this week, ~{max(0.0, projected):.1f} after the sessions under way: not enough for a training")
    else:
        if not state.get("queue"):
            jobs = build_next(state)
            if jobs:
                state.setdefault("queue", []).extend(jobs)
                save(state)
        if state.get("queue"):
            # Two versions share one session when two wait: a kernel has two T4s, one for each.
            jobs = state["queue"][:2]
            pair = ["--pair", jobs[1]["name"], "--pair-data", jobs[1]["data"]] if len(jobs) == 2 else []
            if len(jobs) == 2 and jobs[1].get("args"):
                pair += ["--pair-args", " ".join(jobs[1]["args"])]
            # train_args: kaggle.py options for every version (3 epochs: the fourth added 0.002 held-out agreement to v9a).
            code, out = sh([sys.executable, "training/kaggle.py", "train", "--name", jobs[0]["name"], "--data", jobs[0]["data"], *pair,
                            *jobs[0].get("args", []), *state.get("train_args", [])])
            names = [j["name"] for j in jobs]
            if code:
                log(f"{' and '.join(names)}: push failed: {out[-300:]}")
            else:
                log(f"{' and '.join(names)}: training on Kaggle in one session ({left if left is not None else '?'} GPU hours left)")
                del state["queue"][: len(jobs)]
                state.setdefault("pushed", []).extend(names)
                for n in names:
                    state.setdefault("kernels", {})[n] = f"{names[0]}-train"
            save(state)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--every", type=float, default=10, help="minutes between rounds")
    args = ap.parse_args()
    while True:
        try:
            round_once()
        except Exception as err:  # a bad round must not end the loop
            log(f"round failed: {err!r}")
        if args.once:
            return
        time.sleep(args.every * 60)


if __name__ == "__main__":
    sys.exit(main())
