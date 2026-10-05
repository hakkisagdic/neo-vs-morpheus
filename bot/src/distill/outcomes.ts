// Learning from what happened. Every decision in the recorded duels is scored by what followed it:
// the damage balance over the next seconds (dealt minus taken, in percent of health) plus the
// round's result, which counts more the closer the decision was to the end. Decisions that did
// better than the average in their module become training rows in the shape of the teacher's
// labels: the move that was made, as a sharpened target, asked with today's question
// (advantage-weighted regression). The scripted bot's decisions count too: it wins most rounds.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { FORMAT, compositeQuestion, describeDuel, isOutOfReach } from "../brain/duel-policy.ts";
import { MELEE_FORMAT, describeMelee, meleeQuestion } from "../brain/melee-policy.ts";
import { type Decision, type DuelSnapshot, INTERRUPT_SPELLS, type ModuleName } from "../brain/types.ts";
import { checkRun } from "../eval/run-checks.ts";
import type { LabeledState } from "./label.ts";

export type RunRecord = { at: number; bot: string; decision: Decision; snapshot: DuelSnapshot; outcome?: { result: string; castMs?: number } };
export type Run = { match: { results: { winner: string | null }[] }; records: RunRecord[] };

/** How long after a decision its damage balance is measured. */
export const HORIZON_MS = 4_000;
/** Weight of the round's result: a win is worth this many health points, fading over 10 s back from the end. */
const RESULT_POINTS = 30;

/** Records split into rounds at the largest gaps in time: the setup between rounds. */
export function splitRounds(records: RunRecord[], rounds: number): RunRecord[][] {
  if (rounds <= 1 || records.length < 2) {
    return [records];
  }
  const gaps = records.slice(1).map((r, i) => ({ i: i + 1, gap: r.at - records[i].at }));
  const cuts = gaps
    .sort((a, b) => b.gap - a.gap)
    .slice(0, rounds - 1)
    .map((g) => g.i)
    .sort((a, b) => a - b);
  return [0, ...cuts].map((start, k) => records.slice(start, cuts[k] ?? records.length));
}

const MELEE_KEYS: Record<string, (p: Decision["plan"]) => string | null> = {
  attack: (p) => `attack:${"ability" in p && p.ability ? p.ability : "swing"}`,
  bandage: () => "heal:bandage",
  drink: (p) => ("potion" in p ? (p.potion === "heal" ? "heal:potion" : `${p.potion}:potion`) : null),
  throw: () => "throw:explosion",
  retreat: () => "move:retreat",
};

/** The option a decision carried out, as a key of today's question; null when it only waited. */
export function takenKey(d: Decision, s: DuelSnapshot): string | null {
  if (d.explored) {
    return d.explored; // tried in place of the model's choice, and carried out as such
  }
  const p = d.plan;
  if (d.module === "melee") {
    return MELEE_KEYS[p.kind]?.(p) ?? null;
  }
  switch (p.kind) {
    case "cast":
      if (p.target === "self") {
        return `defense:${p.spell}`;
      }
      return `${d.mode.choice === "interrupt" && (INTERRUPT_SPELLS as readonly string[]).includes(p.spell) ? "interrupt" : "damage"}:${p.spell}`;
    case "teleport":
      return isOutOfReach(s) ? "damage:chase" : "damage:teleport";
    case "approach":
      return "damage:chase";
    case "retreat":
      return "defense:retreat";
    case "wait":
      return p.hold ? "defense:hold" : null;
    default:
      return null;
  }
}

export type Scored = {
  id: string;
  bot: string;
  brain: string;
  module: ModuleName;
  key: string;
  /** Damage dealt minus taken over the horizon, plus the round's result, in health points. */
  ret: number;
  snapshot: DuelSnapshot;
};

const healthOf = (s: DuelSnapshot) => ({ us: (100 * s.us.hits) / Math.max(1, s.us.hitsMax), them: s.them.healthPct });

export function scoreRun(file: string, run: Run): Scored[] {
  const index = new Map(run.records.map((r, i) => [r, i]));
  const out: Scored[] = [];
  splitRounds(run.records, run.match.results.length).forEach((records, round) => {
    const winner = run.match.results[round]?.winner ?? null;
    const end = records.at(-1)?.at ?? 0;
    for (const bot of new Set(records.map((r) => r.bot))) {
      const mine = records.filter((r) => r.bot === bot);
      for (const rec of mine) {
        const key = takenKey(rec.decision, rec.snapshot);
        if (!key) {
          continue;
        }
        const later = mine.find((r) => r.at >= rec.at + HORIZON_MS) ?? mine.at(-1) ?? rec;
        const before = healthOf(rec.snapshot);
        const after = healthOf(later.snapshot);
        const result = winner === null ? 0 : winner === bot ? 1 : -1;
        const ret = before.them - after.them - (before.us - after.us) + RESULT_POINTS * result * Math.exp(-(end - rec.at) / 10_000);
        // Runs from before modules existed are the mage's.
        const module = rec.decision.module ?? "mage";
        out.push({ id: `outcome:${file}:${index.get(rec)}`, bot, brain: rec.decision.brain, module, key, ret, snapshot: rec.snapshot });
      }
    }
  });
  return out;
}

/** A run file's time stamp, whichever machine played it ("alastyr--2026-10-05T…" or "2026-10-05T…"). */
export const runStamp = (file: string): string => (file.includes("--") ? file.slice(file.lastIndexOf("--") + 2) : file);

/** Scored decisions of every run since a time stamp, leaving out runs that fail the run checks. */
export async function scoreRuns(runsDir: string, since = "", log: (m: string) => void = () => {}): Promise<Scored[]> {
  const files = (await readdir(runsDir)).filter((f) => f.endsWith(".json") && runStamp(f) >= since).sort();
  const out: Scored[] = [];
  for (const file of files) {
    const run = JSON.parse(await readFile(join(runsDir, file), "utf8")) as Run;
    // Checked again rather than read from the file, so that runs from before the checks count too.
    const problems = checkRun(run.records).flatMap((c) => c.problems);
    if (problems.length) {
      log(`skipping ${file}: ${problems.join("; ")}`);
      continue;
    }
    out.push(...scoreRun(file, run));
  }
  return out;
}

/** A decision must beat its module's average by this many health points to become a row. */
export const MIN_ADVANTAGE = 10;
/**
 * At most this many rows per move, so that routine moves (a dexer's swing) do not drown the rest.
 * Raised from 300 for v7: imitation left Laya's Explosion at about 1.5% where the scripted bot's
 * Explosions scored best, and more of the moves that won had to reach training.
 */
export const MAX_PER_MOVE = 1_000;

/**
 * Training rows from the scored decisions that clearly beat their module's average: today's state
 * text and question, the move made as 80% of the target (the rest spread over the other legal
 * moves), and the advantage recorded. A move today's question no longer offers is skipped, and so
 * is a state already seen; the best-scoring decisions come first when a move hits its cap.
 */
export function outcomeLabels(scored: Scored[]): LabeledState[] {
  const baseline = new Map<ModuleName, number>();
  for (const module of new Set(scored.map((s) => s.module))) {
    const rets = scored.filter((s) => s.module === module).map((s) => s.ret);
    baseline.set(module, rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length));
  }
  const seen = new Set<string>();
  const perMove = new Map<string, number>();
  const rows: LabeledState[] = [];
  const ranked = scored
    .map((s) => ({ s, advantage: s.ret - (baseline.get(s.module) ?? 0) }))
    .filter((x) => x.advantage >= MIN_ADVANTAGE)
    .sort((a, b) => b.advantage - a.advantage);
  for (const { s, advantage } of ranked) {
    const move = `${s.module}/${s.key}`;
    if ((perMove.get(move) ?? 0) >= MAX_PER_MOVE) {
      continue;
    }
    const melee = s.module === "melee";
    const state = melee ? describeMelee(s.snapshot) : describeDuel(s.snapshot);
    const questions = melee ? meleeQuestion(s.snapshot) : compositeQuestion(s.snapshot);
    const options = Object.keys(questions.move.criteria);
    if (!options.includes(s.key) || options.length < 2 || seen.has(state)) {
      continue;
    }
    seen.add(state);
    perMove.set(move, (perMove.get(move) ?? 0) + 1);
    const rest = 0.2 / (options.length - 1);
    const probabilities = Object.fromEntries(options.map((k) => [k, k === s.key ? 0.8 : rest]));
    rows.push({
      id: s.id,
      source: "run",
      module: s.module,
      format: melee ? MELEE_FORMAT : FORMAT,
      state,
      questions,
      teacher: { model: `outcome:${s.brain}`, probabilities, inputTokens: 0, advantage: Math.round(advantage * 10) / 10 },
    } as LabeledState);
  }
  return rows;
}
