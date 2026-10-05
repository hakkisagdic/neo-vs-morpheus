// Results across machines: every run file in runs/, whichever instance played it, tallied by
// matchup. A side is described by what decides for it (the checkpoint, or the scripted bot and its
// reaction time), the template and the tactics, so "laya first" and "laya second" entries, slots and
// lanes all add up into one row.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { checkRun } from "../eval/run-checks.ts";

type Fighter = { name: string; brain: string; template?: string; tactics?: string; reactionMs?: number };

export type RunFile = {
  versions?: { models?: Record<string, string>; where?: { instance?: string; lane?: string }; [k: string]: unknown };
  match: {
    title: string;
    fighters: Fighter[];
    startedAt: number;
    arena?: string;
    distance?: number;
    results: { winner: string | null }[];
    checks?: { problems: string[] }[];
  };
  records?: Parameters<typeof checkRun>[0];
};

export type RunInfo = {
  file: string;
  instance: string;
  lane?: string;
  startedAt: number;
  arena: string;
  sides: string[];
  /** Round wins per side, in the order of `sides`. */
  wins: number[];
  draws: number;
  problems: string[];
};

export type Row = {
  matchup: string;
  sides: string[];
  wins: number[];
  draws: number;
  runs: number;
  /** Runs left out because a run check flagged them (unless they were asked for). */
  flagged: number;
};

/** "neo-duel-v8 mage", "rules@100 dexer kite": what decides, then the build and the tactics. */
export function describeSide(f: Fighter, model?: string): string {
  if (f.brain === "npc" || f.brain === "human") {
    return `${f.brain} ${f.name}`;
  }
  const who =
    f.brain === "rules"
      ? `rules@${f.reactionMs ?? 0}`
      : f.brain === "laya" || f.brain === "jev"
        ? (model && model !== "laya-rl-agent" ? model : `${f.brain} (model not recorded)`)
        : f.brain;
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
  const problems = (run.records ? checkRun(run.records, m.fighters) : (m.checks ?? [])).flatMap((c) => c.problems);
  return {
    file,
    instance: instanceOf(file, run),
    lane: run.versions?.where?.lane,
    startedAt: m.startedAt,
    arena: `${m.arena ?? "open"} ${m.distance ?? 8}`,
    sides,
    wins,
    draws: m.results.filter((r) => !r.winner).length,
    problems,
  };
}

export type TallyOptions = { since?: number; instance?: string; includeFlagged?: boolean; byArena?: boolean };

/** Rows by matchup (sides sorted so that both seatings add up), most rounds first. */
export function tally(runs: RunInfo[], o: TallyOptions = {}): Row[] {
  const rows = new Map<string, Row>();
  for (const run of runs) {
    if ((o.since && run.startedAt < o.since) || (o.instance && run.instance !== o.instance) || run.sides.length !== 2) {
      continue;
    }
    const order = run.sides[0] <= run.sides[1] ? [0, 1] : [1, 0];
    const sides = order.map((i) => run.sides[i]);
    const matchup = `${sides[0]} vs ${sides[1]}${o.byArena ? ` (${run.arena})` : ""}`;
    const row = rows.get(matchup) ?? { matchup, sides, wins: [0, 0], draws: 0, runs: 0, flagged: 0 };
    rows.set(matchup, row);
    if (run.problems.length && !o.includeFlagged) {
      row.flagged++;
      continue;
    }
    row.runs++;
    row.draws += run.draws;
    order.forEach((from, to) => (row.wins[to] += run.wins[from]));
  }
  return [...rows.values()].sort((a, b) => b.wins[0] + b.wins[1] + b.draws - (a.wins[0] + a.wins[1] + a.draws));
}

export function formatRows(rows: Row[]): string {
  if (!rows.length) {
    return "no runs match";
  }
  return rows
    .map((r) => {
      const total = r.wins[0] + r.wins[1];
      const share = total ? ` (${Math.round((100 * r.wins[0]) / total)}%)` : "";
      const draws = r.draws ? `, ${r.draws} draws` : "";
      const flagged = r.flagged ? `, ${r.flagged} flagged runs left out` : "";
      return `${r.sides[0]} vs ${r.sides[1]}: ${r.wins[0]}-${r.wins[1]}${share}${draws}; ${r.runs} runs${flagged}`;
    })
    .join("\n");
}

export const RUNS_DIR = join(import.meta.dirname, "..", "..", "..", "runs");

/** Every run in runs/, or only the files written since a time (cheaper: no other file is parsed). */
export async function readRuns(dir = RUNS_DIR, modifiedSince = 0): Promise<RunInfo[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  const out: RunInfo[] = [];
  for (const file of files) {
    if (modifiedSince && (await stat(join(dir, file)).catch(() => null))?.mtimeMs! < modifiedSince) {
      continue;
    }
    try {
      out.push(runInfo(file, JSON.parse(await readFile(join(dir, file), "utf8")) as RunFile));
    } catch {
      // a run still being written, or not a run file
    }
  }
  return out;
}
