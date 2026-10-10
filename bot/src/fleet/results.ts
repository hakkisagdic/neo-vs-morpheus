// Results across machines: every run file in runs/, whichever instance played it, tallied by
// matchup. A side is described by what decides for it (the checkpoint, or the scripted bot and its
// reaction time), the template and the tactics, so "laya first" and "laya second" entries, slots and
// lanes all add up into one row.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
  // A model with a decision time of its own ("neo-duel-v8@4000") is kept apart from its usual pace.
  const pace = f.brain !== "rules" && f.reactionMs !== undefined ? `@${f.reactionMs}` : "";
  const who =
    f.brain === "rules"
      ? `rules@${f.reactionMs ?? 0}`
      : (f.brain === "laya" || f.brain === "laya-b" || f.brain === "jev"
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

/** bench: runs of that benchmark track only; false: no benchmark runs (selection keeps away from them). */
export type TallyOptions = { since?: number; instance?: string; includeFlagged?: boolean; byArena?: boolean; bench?: string | false };

/** Rows by matchup (sides sorted so that both seatings add up), most rounds first. */
export function tally(runs: RunInfo[], o: TallyOptions = {}): Row[] {
  const rows = new Map<string, Row>();
  for (const run of runs) {
    const benchOut = o.bench === false ? Boolean(run.bench) : o.bench !== undefined && run.bench !== o.bench;
    if ((o.since && run.startedAt < o.since) || (o.instance && run.instance !== o.instance) || run.sides.length !== 2 || benchOut) {
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

/**
 * Runs read so far, by path, while the file is unchanged: a run file is about a megabyte of JSON.
 * The runs/ entries are also kept on disk, so that a new process (the panel after a restart) reads
 * only the runs written since. The saved index belongs to the code that made it: a change to the
 * sources below reads every run again.
 */
const INDEX = join(import.meta.dirname, "..", "..", "..", ".fleet", "cache", "runs-index.json");
const SOURCES = ["results.ts", "../eval/run-checks.ts", "../game/caster.ts", "../uo/spells.ts"].map((f) => join(import.meta.dirname, f));
type Entry = { mtimeMs: number; info: RunInfo | null };
let index: Promise<{ version: string; entries: Map<string, Entry> }> | null = null;
let saving: Promise<void> | null = null;

function loadIndex(): Promise<{ version: string; entries: Map<string, Entry> }> {
  index ??= (async () => {
    const sources = await Promise.all(SOURCES.map((f) => readFile(f, "utf8").catch(() => "")));
    const version = createHash("sha1").update(sources.join("\n")).digest("hex");
    const entries = new Map<string, Entry>();
    try {
      const saved = JSON.parse(await readFile(INDEX, "utf8")) as { version: string; files: Record<string, Entry> };
      if (saved.version === version) {
        for (const [file, entry] of Object.entries(saved.files)) {
          entries.set(join(RUNS_DIR, file), entry);
        }
      }
    } catch {
      // no index yet, or an unreadable one: every run is read once
    }
    return { version, entries };
  })();
  return index;
}

/** Writes runs/'s entries to disk, one write at a time (a write under way covers the newest state). */
async function saveIndex(): Promise<void> {
  const { version, entries } = await loadIndex();
  const files = Object.fromEntries([...entries].filter(([path]) => dirname(path) === RUNS_DIR).map(([path, entry]) => [basename(path), entry]));
  await mkdir(dirname(INDEX), { recursive: true });
  await writeFile(`${INDEX}.tmp`, JSON.stringify({ version, files }));
  await rename(`${INDEX}.tmp`, INDEX);
}

/** Every run in runs/, or only the files written since a time; a file is parsed again only when it changed. */
export async function readRuns(dir = RUNS_DIR, modifiedSince = 0): Promise<RunInfo[]> {
  const { entries } = await loadIndex();
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  const out: RunInfo[] = [];
  let changed = false;
  for (const file of files) {
    const path = join(dir, file);
    const st = await stat(path).catch(() => null);
    if (!st || st.mtimeMs < modifiedSince) {
      continue;
    }
    let hit = entries.get(path);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
      let info: RunInfo | null = null;
      try {
        info = runInfo(file, JSON.parse(await readFile(path, "utf8")) as RunFile);
      } catch {
        // a run still being written (its next write changes the time), or not a run file
      }
      hit = { mtimeMs: st.mtimeMs, info };
      entries.set(path, hit);
      changed ||= dir === RUNS_DIR;
    }
    if (hit.info) {
      out.push(hit.info);
    }
  }
  if (changed && !saving) {
    saving = saveIndex()
      .catch(() => {})
      .finally(() => (saving = null));
  }
  return out;
}
