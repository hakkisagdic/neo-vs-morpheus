// One run file as the fleet sees it: who played (describeSide), where, the score and the checks.
// The runs index (./results.ts) keeps these per file and is read again whole when this file or
// the checks behind it change, so only what a run's entry is made of belongs here: tallies and
// printing stay in ./results.ts and can change without reading 36,000 runs again.
import { type RunCheck, checkRun } from "../eval/run-checks.ts";

type Fighter = { name: string; brain: string; template?: string; tactics?: string; reactionMs?: number };

export type RunFile = {
  versions?: { models?: Record<string, string>; where?: { instance?: string; lane?: string }; bench?: string; [k: string]: unknown };
  match: {
    title: string;
    fighters: Fighter[];
    rounds?: number;
    startedAt: number;
    arena?: string;
    distance?: number;
    results: { winner: string | null; durationMs?: number }[];
    checks?: Pick<RunCheck, "bot" | "latencyMs" | "problems">[];
  };
  records?: Parameters<typeof checkRun>[0];
};

export type RunInfo = {
  file: string;
  instance: string;
  lane?: string;
  /** The benchmark track that played it ("uo-bench/1:duel-ml"), if any. */
  bench?: string;
  startedAt: number;
  arena: string;
  sides: string[];
  /** Round wins per side, in the order of `sides`. */
  wins: number[];
  draws: number;
  problems: string[];
  /** The Runs page's line for it. */
  summary: RunSummary;
};

/** One recorded run as the Runs page lists it: the score per fighter, round length, decision times, checks. */
export type RunSummary = {
  file: string;
  startedAt: number;
  title: string;
  fighters: Fighter[];
  rounds: number;
  wins: Record<string, number>;
  draws: number;
  avgRoundS: number;
  arena?: string;
  distance?: number;
  versions?: Record<string, unknown>;
  problems: string[];
  latencyMs: Record<string, number>;
};

/** "neo-duel-v8 mage", "rules@100 dexer kite": what decides, then the build and the tactics. */
export function describeSide(f: Fighter, model?: string): string {
  if (f.brain === "npc" || f.brain === "human") {
    return `${f.brain} ${f.name}`;
  }
  // A model with a decision time of its own ("neo-duel-v8@4000") is kept apart from its usual pace.
  const pace = f.brain !== "rules" && f.reactionMs !== undefined ? `@${f.reactionMs}` : "";
  const who =
    f.brain === "rules"
      ? `rules@${f.reactionMs ?? 0}`
      : (f.brain === "laya" || f.brain === "laya-b" || f.brain === "jev" || f.brain === "clef"
          ? (model && model !== "laya-rl-agent" ? model : `${f.brain} (model not recorded)`)
          : f.brain) + pace;
  return [who, f.template ?? "mage", ...(f.tactics && f.tactics !== "neutral" ? [f.tactics] : [])].join(" ");
}

/** The instance that played a run: recorded in the run, else the file's "instance--" prefix, else this Mac. */
export function instanceOf(file: string, run: RunFile): string {
  return run.versions?.where?.instance ?? (file.includes("--") ? file.split("--")[0] : "mac");
}

export function runInfo(file: string, run: RunFile): RunInfo {
  const m = run.match;
  // Runs saved before the fix may name "forced" when a guardrail's move came last; the decisions tell.
  const models = Object.fromEntries(Object.entries(run.versions?.models ?? {}).filter(([, model]) => model !== "forced"));
  // Older runs name no model; their decisions do (for laya-serve only once it reported checkpoints).
  for (const r of run.records ?? []) {
    // "forced": a move the bot made without asking the model (a guardrail), which names no checkpoint.
    if (!models[r.bot] && r.decision.brain !== "rules" && r.decision.model !== "forced") {
      models[r.bot] = r.decision.model;
    }
  }
  const sides = m.fighters.map((f) => describeSide(f, models[f.name]));
  const wins = m.fighters.map((f) => m.results.filter((r) => r.winner === f.name).length);
  // Checked again when the records are there, so that a run saved before a check was added gets it too.
  const checks = run.records ? checkRun(run.records, m.fighters) : (m.checks ?? []);
  const problems = checks.flatMap((c) => c.problems);
  return {
    file,
    instance: instanceOf(file, run),
    lane: run.versions?.where?.lane,
    bench: run.versions?.bench,
    startedAt: m.startedAt,
    arena: `${m.arena ?? "open"} ${m.distance ?? 8}`,
    sides,
    wins,
    draws: m.results.filter((r) => !r.winner).length,
    problems,
    summary: summarise(file, run, checks),
  };
}

/** The Runs page's line for a run; `checks` as runInfo found them (checked here when not given). */
export function summarise(file: string, run: RunFile, checks: Pick<RunCheck, "bot" | "latencyMs" | "problems">[] = checkRun(run.records ?? [], run.match.fighters)): RunSummary {
  const m = run.match;
  const wins: Record<string, number> = {};
  for (const r of m.results) {
    if (r.winner) {
      wins[r.winner] = (wins[r.winner] ?? 0) + 1;
    }
  }
  const total = m.results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  return {
    file,
    startedAt: m.startedAt,
    title: m.title,
    fighters: m.fighters,
    rounds: m.results.length,
    wins,
    draws: m.results.filter((r) => !r.winner).length,
    avgRoundS: m.results.length ? Math.round(total / m.results.length / 1000) : 0,
    arena: m.arena,
    distance: m.distance,
    versions: run.versions,
    problems: checks.flatMap((c) => c.problems),
    latencyMs: Object.fromEntries(checks.flatMap((c) => (c.bot ? [[c.bot, c.latencyMs]] : []))),
  };
}
