#!/usr/bin/env python3
"""Keeps Kaggle training Laya without a break, one round every 10 minutes:

    python3 lab/trainer.py            # until stopped
    python3 lab/trainer.py --once     # one round

1. A training kernel that finished is fetched (training/kaggle.py fetch), published to the private
   model repo, and put on a free candidate lane of the gate's machine (this Mac, or a Colab VM:
   state "gate_machine") against the scripted bot at matched speed (lab/evaluate.py); with no lane
   free it waits in line. Once a candidate and the champion have each played the gate's rounds of
   every build since the candidate came (state "gate_builds", "gate_rounds", "gate_series"), one
   look: a one-sided z-test (95%) on the difference in shares, taken within each arena and seat
   and averaged over them and over the builds, promotes it (the champion's lanes become its) or
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
#: Decided rounds of every build each side needs before a candidate is promoted or dropped, and the
#: one-sided z for 95% confidence; the scripted bot at this reaction time or quicker is "matched
#: speed". The gate decides once, at these rounds: looking again and again as rounds come in would
#: raise its error well past the stated 5% (an adversarial review measured 18% over 3 hours).
GATE_ROUNDS = 800
#: Runs each side needs in every arena and seat it is compared in: the error comes from their spread.
GATE_STRATUM_RUNS = 3
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
    """The checkpoint takes a free candidate lane on the gate's machine, or waits in line for one: a
    candidate keeps its lane until its one look, whatever arrives after it."""
    candidates = state.setdefault("candidates", {})
    waiting = state.setdefault("waiting", [])
    if name in candidates.values() or name == state.get("champion"):
        return
    # The champion must keep a lane to play on: its last one is not given to a candidate.
    champion_lanes = [lane for lane, model in gate_lanes(state).items() if model == state.get("champion")]
    free = [l for l in state.get("eval_lanes", [0, 2]) if str(l) not in candidates and champion_lanes != [l]]
    if not free:
        if name not in waiting:
            waiting.append(name)
            log(f"{name}: waits for a candidate lane ({len(waiting)} in line)")
        return
    # Its rounds count from before its lane starts: the first matches begin while the start returns.
    state.setdefault("eval_since", {})[name] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    code, out = put_on_lane(state, free[0], name)
    # A start that failed is tried again by the keeper: the plan names the lane's checkpoint already.
    log(f"{name}: evaluating on {gate_machine(state)} lane {free[0]}" if not code else f"{name}: evaluation start failed: {out[-300:]}")
    if name in waiting:
        waiting.remove(name)
    candidates[str(free[0])] = name
    state.setdefault("arrived", []).append(name)


def seat_waiting(state):
    """Checkpoints in line take the candidate lanes that came free, the first in line first."""
    for name in list(state.get("waiting", [])):
        evaluate(state, name)
        if name in state["waiting"]:
            break


def gate_machine(state):
    """The fleet machine the gate's lanes play on: this Mac, or a Colab VM (many more rounds an hour)."""
    return state.get("gate_machine", "mac")


def gate_builds(state):
    """The builds a candidate is judged on, each against the scripted bot at matched speed."""
    return state.get("gate_builds", ["mage"])


def gate_rounds(state):
    """Decided rounds each side plays of every build before the gate's one look."""
    return state.get("gate_rounds", GATE_ROUNDS)


def gate_series(state):
    """The series the gate's lanes play (lab/evaluate.py's own on this Mac)."""
    return os.path.join(ROOT, state.get("gate_series", os.path.join(".fleet", "mac", "series", "matched40x3.json")))


def gate_lanes(state):
    """The plan's lanes on the gate's machine that play the gate's series, {lane: checkpoint}: a
    bench or a sparring lane of the same checkpoint is not the gate's to move."""
    with open(os.path.join(ROOT, ".fleet", "plan.json")) as f:
        lanes = json.load(f).get(gate_machine(state), [])
    series = os.path.basename(gate_series(state))
    return {l["lane"]: l.get("model") for l in lanes if os.path.basename(l.get("series", "")) == series}


def put_on_lane(state, lane, name):
    """The lane of the gate's machine plays the checkpoint from now on, on the gate's series."""
    arenas = ["--parallel", str(state["gate_parallel"])] if state.get("gate_parallel") else []
    return sh([sys.executable, "lab/evaluate.py", "--model", name, "--lane", str(lane), "--machine", gate_machine(state),
               "--series", gate_series(state), *arenas])


RUN_LINE = re.compile(r"^run: (.+?) \| (.+?) \| (.+?) \| (\d+)-(\d+)-\d+ \| \S+$", re.M)


def gate_runs(state, since):
    """Every counted run against the scripted bot at matched speed (rules@60 or quicker, the same
    build) on the gate's machine since a time, by checkpoint: {checkpoint: [(build, stratum, wins,
    losses)]}, a stratum being the run's arena and the checkpoint's seat. A Colab VM lists its own
    runs (fleet there): they need not come to this Mac first."""
    # Benchmark runs stay out: a bench score must come from rounds no selection has seen.
    machine = gate_machine(state)
    where = ["fleet", "results", "--instance", "mac"] if machine == "mac" else ["fleet", "there", machine, "fleet", "results"]
    code, out = sh(["npm", "run", "-s", "nvm", "--", *where, "--runs", "--since", since, "--no-bench"], cwd=BOT, timeout=900)
    if code or not re.search(r"^runs: \d+ counted", out, re.M):
        raise RuntimeError(f"no results from {machine}: {out[-200:]}")
    runs = {}
    for first, second, arena, w0, w1 in RUN_LINE.findall(out):
        for seat, (me, other, wins, losses) in enumerate(((first, second, w0, w1), (second, first, w1, w0))):
            model, rules = re.fullmatch(r"(neo-\S+) (\w+)", me), re.fullmatch(r"rules@(\d+) (\w+)", other)
            if model and rules and model.group(2) == rules.group(2) and int(rules.group(1)) <= MATCHED_MS:
                runs.setdefault(model.group(1), []).append((model.group(2), f"{arena}, seat {seat + 1}", int(wins), int(losses)))
    return runs


def shares(state, runs):
    """ "mage 68% (600-280), dexer 45% (270-330)" for a checkpoint's runs of the gate's builds."""
    said = []
    for b in gate_builds(state):
        w, l = (sum(r[k] for r in runs if r[0] == b) for k in (2, 3))
        said.append(f"{b} {100 * w / max(1, w + l):.0f}% ({w}-{l})")
    return ", ".join(said)


def strata_of(runs, build):
    """A build's decided runs by stratum (arena and seat): {stratum: [(wins, losses)]}."""
    strata = {}
    for b, stratum, wins, losses in runs:
        if b == build and wins + losses:
            strata.setdefault(stratum, []).append((wins, losses))
    return strata


def gate_waits(mine, best, builds, need, runs_each=None):
    """Why the gate does not look yet ("" when it does): either side has fewer than `need` decided
    rounds of a build, or fewer than `runs_each` runs in an arena and seat that one of them played."""
    runs_each = GATE_STRATUM_RUNS if runs_each is None else runs_each
    for b in builds:
        sides = [strata_of(mine, b), strata_of(best, b)]
        played = [sum(w + l for rs in side.values() for w, l in rs) for side in sides]
        if min(played) < need:
            return f"waiting for {need} decided rounds of {b} each ({played[0]} and {played[1]})"
        for stratum in sorted(set(sides[0]) | set(sides[1])):
            if min(len(side.get(stratum, [])) for side in sides) < runs_each:
                return f"waiting for {runs_each} runs each of {b} at {stratum}"
    return ""


def stratum_share(runs):
    """The share of decided rounds over a stratum's runs [(wins, losses)], and that share's variance.
    The rounds of a run go together, so the variance comes from the spread between runs (a ratio's
    linearised variance); it is never taken below the binomial one of a share pulled a little towards
    a half (runs that all end 10-0 would say there is none)."""
    n = len(runs)
    wins, decided = sum(w for w, _ in runs), sum(w + l for w, l in runs)
    p = wins / decided
    between = n / (n - 1) * sum((w - p * (w + l)) ** 2 for w, l in runs) / decided**2 if n > 1 else 1.0
    smooth = (wins + 1) / (decided + 2)
    return p, max(between, smooth * (1 - smooth) / decided)


def gate_difference(mine, best, builds):
    """The candidate's share less the champion's and its standard error: within each arena and seat
    first, then the mean over a build's strata, then the mean over the builds. Arenas and seats
    differ a lot (a dexer's share runs from a few percent to nearly all of them) and both sides play
    the same ones equally often, so their spread is no part of the error; the spread between the
    runs of one stratum is. (A share's variance was 2 to 6 times the binomial one over a bench
    track's runs taken together, against the 1.3 the gate used to assume.)"""
    diff, variance = 0.0, 0.0
    for b in builds:
        sides = [strata_of(mine, b), strata_of(best, b)]
        strata = set(sides[0]) & set(sides[1])
        for stratum in strata:
            (p1, v1), (p2, v2) = stratum_share(sides[0][stratum]), stratum_share(sides[1][stratum])
            diff += (p1 - p2) / len(strata) / len(builds)
            variance += (v1 + v2) / len(strata) ** 2 / len(builds) ** 2
    return diff, math.sqrt(variance)


def switch_lanes(state, old, new):
    """Every gate lane that plays `old` plays `new` from now on."""
    lanes = [lane for lane, model in gate_lanes(state).items() if model == old]
    for lane in lanes:
        put_on_lane(state, lane, new)
    return lanes


def gate(state):
    """Each candidate against the champion over the same hours, on the gate's machine, series and
    builds: once both have the gate's rounds of every build, one look. A one-sided z-test on the
    difference in shares (gate_difference) promotes a better candidate, or one no worse by the
    margin when it brings skill training (the champion's gate lanes become its), and otherwise drops
    it (its lane goes back to the champion). At most one promotion a pass: the rest were measured
    against the old champion. Checkpoints in line take the lanes that come free."""
    champion = state.setdefault("champion", "neo-duel-v8")
    seat_waiting(state)
    for lane, name in list(state.get("candidates", {}).items()):
        since = state.get("eval_since", {}).get(name)
        if not since or name == champion:
            continue
        skilled = state.get("skills", [])
        if champion in skilled and name not in skilled:
            # The champion trains skills too; a version that cannot would lose that, however it duels.
            state.setdefault("history", []).append({"dropped": name, "at": since, "result": f"{name} cannot train skills; {champion} can"})
            del state["candidates"][lane]
            seat_waiting(state)
            if lane not in state["candidates"]:
                put_on_lane(state, lane, champion)
            log(f"dropped: {name} cannot train skills; lane {lane} plays {state['candidates'].get(lane, champion)}")
            track(name)
            save(state)
            continue
        runs = gate_runs(state, since)
        mine, best = runs.get(name, []), runs.get(champion, [])
        builds = gate_builds(state)
        waits = gate_waits(mine, best, builds, gate_rounds(state))
        if waits:
            log(f"{name} {shares(state, mine)} against {champion} {shares(state, best)}; {waits}")
            continue
        diff, se = gate_difference(mine, best, builds)
        # A candidate that brings something new (skill training) needs only to be no worse at duels:
        # a non-inferiority test, its share plus the margin against the champion's. The margin needs
        # evidence that it does train skills: agreement with the oracle on sampled training states.
        margin = state.get("margins", {}).get(name, 0.0)
        if not margin and name in skilled and champion not in skilled:
            agreement = skill_agreement(state, name, lane)
            margin = SKILL_MARGIN if agreement is not None and agreement >= SKILL_AGREEMENT else 0.0
        z = (diff + margin) / se
        verdict = (f"{name} {shares(state, mine)} against {champion} {shares(state, best)}: {100 * diff:+.1f} points within arenas and seats"
                   f" (standard error {100 * se:.1f}), z {z:+.2f}" + (f" (no worse by {100 * margin:.0f} points)" if margin else ""))
        if z > GATE_Z:
            moved = switch_lanes(state, champion, name)
            state["champion"] = name
            state.setdefault("label_since", {})[name] = since[:16].replace(":", "-")
            state.setdefault("history", []).append({"promoted": name, "over": champion, "at": since, "result": verdict})
            del state["candidates"][lane]
            log(f"promoted: {verdict}; lanes {moved} now play it")
            track(name, champion)
            # The other candidates were measured against the old champion: they wait for the next pass.
            save(state)
            return
        # Not shown better (or no worse): it leaves at its one look; its lane goes to the next in line,
        # or back to the champion.
        state.setdefault("history", []).append({"dropped": name, "at": since, "result": verdict})
        del state["candidates"][lane]
        seat_waiting(state)
        if lane not in state["candidates"]:
            put_on_lane(state, lane, champion)
        log(f"dropped: {verdict}; lane {lane} plays {state['candidates'].get(lane, champion)}")
        track(name)
        save(state)
    seat_waiting(state)
    save(state)


def skill_agreement(state, name, lane):
    """How often the candidate (its Laya server on lane's port) picks what the oracle trainer picks on
    sampled training states; measured once, kept in the state. None when it cannot be measured."""
    known = state.setdefault("skillcheck", {})
    if name in known:
        return known[name]
    there = [] if gate_machine(state) == "mac" else ["fleet", "there", gate_machine(state)]
    code, out = sh(["npm", "run", "-s", "nvm", "--", *there, "skillcheck", f"http://127.0.0.1:{8001 + int(lane)}", "200"], cwd=BOT, timeout=1800)
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
    "eval_lanes": [the gate machine's lanes for candidates], "gate_machine": "colab-pro",
    "gate_builds": ["mage", "dexer", "archer"], "gate_rounds": 600, "gate_series": "lab/series-gate3.json",
    "gate_parallel": 8}. A candidate takes a free lane or waits in line for one."""
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
    for key in ("set", "set_trains_skills", "queue", "seed_prefix", "next_seed", "recipe", "train_args", "eval_lanes",
                "gate_machine", "gate_builds", "gate_rounds", "gate_series", "gate_parallel"):
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
