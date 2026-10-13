#!/usr/bin/env python3
"""Asks a large model on the Evren LLM gateway to label training rows, as a teacher in Jev's place:

    python3 lab/teacher.py scenarios --models glm-5.3,deepseek-v4.1-flash
    python3 lab/teacher.py pilot --models glm-5.3,deepseek-v4.1-flash --n 40
    python3 lab/teacher.py label --model glm-5.3 --data training/data/composite-4/train-v8.jsonl \
        --out training/data/teacher/glm-5.3/train-v8.jsonl [--workers 8]

Each row keeps its state and options (the same question Laya reads); only the teacher's answer
changes, so that a model trained on the new labels differs from the champion in the teacher alone.
The model is asked for a probability per move as JSON; reasoning models think first (GLM 5.3 took
~2,400 tokens and ~150 s a question, and gave no answer within 4,000). `scenarios` asks the 29 duel
moments with known right answers (bot/src/eval/scenarios.ts, exported to
training/data/teacher/scenarios.json): the cheap test of a teacher, which Jev scored 9/12 on the
duel suite. `pilot` labels a seeded sample of the rows Jev labelled and reports cost, time, failures
and agreement with Jev. The gateway allows 15M tokens a day over all of a user's keys: --budget stops
a run before it takes more than its share.

The gateway is OpenAI-compatible (https://evren-llmapi.ssyz.org.tr/v1); its key comes from
EVREN_API_KEY or opencode's login (~/.local/share/opencode/auth.json) and is never printed.
Standard library only.
"""
import argparse
import concurrent.futures
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = os.environ.get("EVREN_BASE_URL", "https://evren-llmapi.ssyz.org.tr/v1")

SYSTEM = (
    "You are an expert Ultima Online player judging a PvP duel under Mondain's Legacy rules on a "
    "ModernUO server. You get the duel as one fighter sees it and the moves that fighter can make right "
    "now. Judge which move gives that fighter the best chance to win the duel. Answer with one JSON "
    'object and nothing else: {"probabilities": {"<move key>": <probability>, ...}}, with every listed '
    "key, the probabilities summing to 1."
)


def api_key():
    if os.environ.get("EVREN_API_KEY"):
        return os.environ["EVREN_API_KEY"]
    with open(os.path.expanduser("~/.local/share/opencode/auth.json")) as f:
        return json.load(f)["evren"]["key"]


def question(row):
    q = row["questions"]["move"]
    moves = "\n".join(f"- {key}: {text}" for key, text in q["criteria"].items())
    return f"{row['state']}\n\n{q['instructions']}\nMoves:\n{moves}"


def parse(content, keys):
    """The model's distribution over the keys, from the last JSON object in its answer; None if unusable."""
    for match in reversed(list(re.finditer(r"\{.*\}", content or "", re.S))):
        try:
            found = json.loads(match.group(0))
        except ValueError:
            continue
        probs = found.get("probabilities", found) if isinstance(found, dict) else None
        if not isinstance(probs, dict):
            continue
        p = {k: max(0.0, float(probs.get(k, 0) or 0)) for k in keys}
        total = sum(p.values())
        if total > 0:
            return {k: v / total for k, v in p.items()}
    return None


class BudgetSpent(Exception):
    pass


class Teacher:
    def __init__(self, model, max_tokens=16000, budget=None):
        self.model, self.max_tokens, self.key, self.budget = model, max_tokens, api_key(), budget
        self.lock = threading.Lock()
        self.credits = None
        self.spent = 0

    def ask(self, row, tries=4):
        if self.budget is not None and self.spent >= self.budget:
            return {"error": f"token budget of {self.budget} spent"}
        keys = list(row["questions"]["move"]["criteria"])
        body = {"model": self.model, "temperature": 0, "max_tokens": self.max_tokens,
                "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": question(row)}]}
        for attempt in range(tries):
            req = urllib.request.Request(f"{BASE}/chat/completions", data=json.dumps(body).encode(),
                                         headers={"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
            t = time.time()
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    out = json.load(r)
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 504) and attempt + 1 < tries:
                    time.sleep(5 * 2**attempt)
                    continue
                return {"error": f"HTTP {e.code}: {e.read()[:200].decode('utf8', 'replace')}"}
            except Exception as e:  # a dropped connection or a timeout: once more
                if attempt + 1 < tries:
                    time.sleep(5 * 2**attempt)
                    continue
                return {"error": repr(e)[:200]}
            usage = out.get("usage") or {}
            with self.lock:
                self.spent += usage.get("total_tokens", 0)
                remaining = (usage.get("evren") or {}).get("credits_remaining_cr")
                if remaining is not None:
                    self.credits = float(remaining)
            content = out["choices"][0]["message"].get("content")
            return {"probabilities": parse(content, keys), "seconds": time.time() - t,
                    "input": usage.get("prompt_tokens", 0), "output": usage.get("completion_tokens", 0),
                    "reasoning": (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0),
                    "raw": None if parse(content, keys) else (content or "")[-300:]}
        return {"error": "no answer"}


def label(rows, teacher, workers, done=None):
    """(row, answer) pairs in row order; `done(i, answer)` after each."""
    answers = [None] * len(rows)
    with concurrent.futures.ThreadPoolExecutor(workers) as pool:
        futures = {pool.submit(teacher.ask, row): i for i, row in enumerate(rows)}
        for future in concurrent.futures.as_completed(futures):
            i = futures[future]
            answers[i] = future.result()
            if done:
                done(i, answers[i])
    return list(zip(rows, answers))


def argmax(p):
    return max(p.items(), key=lambda kv: kv[1])[0] if p else None


def pilot(args):
    rows = [json.loads(line) for line in open(os.path.join(ROOT, args.data)) if line.strip()]
    jev = [r for r in rows if r["teacher"].get("model", "").startswith("typesafe/jev")]
    random.Random(args.seed).shuffle(jev)
    by_module = {}
    for r in jev:
        by_module.setdefault(r.get("module", "mage"), []).append(r)
    sample = [r for m in sorted(by_module) for r in by_module[m][: args.n // len(by_module)]]
    print(f"{len(sample)} rows ({', '.join(f'{m} {len(v[: args.n // len(by_module)])}' for m, v in sorted(by_module.items()))}) labelled by Jev", flush=True)
    summary = {}
    for model in args.models.split(","):
        teacher = Teacher(model)
        start, before = time.time(), None
        probe = teacher.ask(sample[0])
        before = teacher.credits
        pairs = label(sample[1:], teacher, args.workers)
        pairs.insert(0, (sample[0], probe))
        ok = [(r, a) for r, a in pairs if a.get("probabilities")]
        agree = sum(argmax(a["probabilities"]) == argmax(r["teacher"]["probabilities"]) for r, a in ok)
        by = {}
        for r, a in ok:
            m = r.get("module", "mage")
            by.setdefault(m, [0, 0])
            by[m][0] += argmax(a["probabilities"]) == argmax(r["teacher"]["probabilities"])
            by[m][1] += 1
        spent = None if before is None or teacher.credits is None else before - teacher.credits
        secs = [a["seconds"] for _, a in ok]
        summary[model] = {
            "answered": len(ok), "failed": len(pairs) - len(ok), "agree_with_jev": round(agree / max(1, len(ok)), 3),
            "by_module": {m: f"{a}/{n}" for m, (a, n) in by.items()},
            "median_s": round(sorted(secs)[len(secs) // 2], 1) if secs else None,
            "tokens_per_row": round(sum(a["input"] + a["output"] for _, a in ok) / max(1, len(ok))),
            "reasoning_per_row": round(sum(a["reasoning"] for _, a in ok) / max(1, len(ok))),
            "credits_for_rest": None if spent is None else round(spent, 4),
            "credits_left": teacher.credits, "wall_s": round(time.time() - start),
            "errors": [a.get("error") or a.get("raw") for _, a in pairs if not a.get("probabilities")][:3],
        }
        print(model, json.dumps(summary[model]), flush=True)
        out = os.path.join(ROOT, "training", "data", "teacher", "pilot", f"{model}.jsonl")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w") as f:
            for r, a in pairs:
                f.write(json.dumps({"id": r["id"], "module": r.get("module"), "jev": r["teacher"]["probabilities"], "answer": a}) + "\n")
    return summary


def scenarios(args):
    """Each model on the scenario suites: right when its most likely move is one the scenario accepts."""
    cases = json.load(open(os.path.join(ROOT, "training", "data", "teacher", "scenarios.json")))
    for case in cases:
        case["questions"]["move"].setdefault("instructions", "What should Neo do next?")
    results = {}
    for model in args.models.split(","):
        teacher = Teacher(model, budget=args.budget)
        pairs = label(cases, teacher, args.workers)
        score, lines = {}, []
        for case, answer in pairs:
            p = answer.get("probabilities")
            pick = argmax(p) if p else None
            ok = pick in case["accept"]
            suite = score.setdefault(case["suite"], [0, 0, 0])
            suite[0] += ok
            suite[1] += 1
            suite[2] += p is None
            lines.append({"suite": case["suite"], "id": case["id"], "accept": case["accept"], "pick": pick, "right": ok,
                          "seconds": round(answer.get("seconds", 0)), "tokens": answer.get("input", 0) + answer.get("output", 0),
                          "error": answer.get("error") or (answer.get("raw") if p is None else None)})
        results[model] = {s: f"{r}/{n}" + (f" ({u} unanswered)" if u else "") for s, (r, n, u) in score.items()}
        results[model]["tokens"] = teacher.spent
        print(model, json.dumps(results[model]), flush=True)
        out = os.path.join(ROOT, "training", "data", "teacher", "scenarios", f"{model}.jsonl")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w") as f:
            f.writelines(json.dumps(line) + "\n" for line in lines)
    return results


def label_file(args):
    rows = [json.loads(line) for line in open(os.path.join(ROOT, args.data)) if line.strip()]
    teacher = Teacher(args.model)
    out_path = os.path.join(ROOT, args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    # Rows already labelled (a run that stopped) are kept and not asked again.
    have = {}
    if os.path.exists(out_path):
        for line in open(out_path):
            if line.strip():
                r = json.loads(line)
                have[r["id"]] = r
    todo = [r for r in rows if r["id"] not in have]
    print(f"{len(rows)} rows, {len(have)} done, {len(todo)} to ask {args.model}", flush=True)
    lock, count, failed = threading.Lock(), [0], [0]
    f = open(out_path, "a")

    def done(i, answer):
        row = todo[i]
        with lock:
            count[0] += 1
            if answer.get("probabilities"):
                labelled = dict(row, teacher={"model": f"evren/{args.model}", "probabilities": answer["probabilities"],
                                               "inputTokens": answer["input"]})
                f.write(json.dumps(labelled) + "\n")
                f.flush()
            else:
                failed[0] += 1
            if count[0] % 200 == 0:
                print(f"{time.strftime('%H:%M')} {count[0]}/{len(todo)}, {failed[0]} failed, credits left {teacher.credits}", flush=True)

    label(todo, teacher, args.workers, done)
    f.close()
    print(f"done: {count[0] - failed[0]} labelled, {failed[0]} failed, credits left {teacher.credits}", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    p = sub.add_parser("scenarios")
    p.add_argument("--models", default="glm-5.3,deepseek-v4.1-flash")
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--budget", type=int, default=600_000, help="tokens a model may take at most")
    p.set_defaults(run=scenarios)
    p = sub.add_parser("pilot")
    p.add_argument("--models", default="glm-5.3,deepseek-v4.1-flash,qwen3.8-flash-next")
    p.add_argument("--data", default="training/data/composite-4/train-v8.jsonl")
    p.add_argument("--n", type=int, default=40)
    p.add_argument("--seed", type=int, default=20261013)
    p.add_argument("--workers", type=int, default=6)
    p.set_defaults(run=pilot)
    p = sub.add_parser("label")
    p.add_argument("--model", required=True)
    p.add_argument("--data", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--workers", type=int, default=8)
    p.set_defaults(run=label_file)
    args = ap.parse_args()
    args.run(args)


if __name__ == "__main__":
    sys.exit(main())
