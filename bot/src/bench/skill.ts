// UO Bench's skill tracks: training sessions (runs/*-skill.json, from src/game/skill-session.ts),
// each one an independent draw, scored two ways: Magery gained in the first minutes, and the
// minutes to a goal, the cap when it was not reached (a restricted mean, so that a player that
// never gets there is not left out). Intervals: bench/stats.ts's meanInterval over sessions.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNS_DIR } from "../fleet/results.ts";
import { type SkillResult, longestStep, mageryAt } from "../game/skill-session.ts";
import { TRAIN_FORMAT } from "../game/train-brain.ts";
import type { TrainStep } from "../game/train.ts";
import { BENCH_LATENCY_MS } from "./leaderboard.ts";
import { meanInterval } from "./stats.ts";

/** format: the training prompt and odds of the session (TRAIN_FORMAT); none before "skill-2". */
export type SkillRun = { file: string; bench?: string; format?: string; result: SkillResult };

export type SkillScore = {
  /** The leaderboard's name for it ("ml/skill-magery: gain in 20 min"). */
  name: string;
  metric: "gain" | "time";
  about?: string;
  /** Settled once the interval is within this either way (skill points, or minutes). */
  half_width: number;
};

export type SkillTrack = { kind: "skill"; about?: string; minutes: number; goal: number; cap: number; scores: SkillScore[] };

export type SkillRow = {
  track: string;
  metric: "gain" | "time";
  player: string;
  sessions: number;
  /** Sessions a check flagged (failed decisions, a restock, too slow for the bench): left out. */
  flagged: number;
  /** Mean gain in skill points, or mean minutes to the goal. */
  score: number;
  interval: [number, number];
  /** Sessions that reached the goal, for a time score. */
  reached?: number;
  settled: boolean;
};

/** Seconds beyond its decision time that no step should take (a rest waits 10 s at most). */
export const STALL_S = 30;

/** Sessions below which no skill score counts as settled. */
export const MIN_SESSIONS = 20;

/** Every training session in runs/ (the "-skill.json" files only: the duel runs are not read). */
export async function readSkillRuns(dir = RUNS_DIR): Promise<SkillRun[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith("-skill.json"));
  const out: SkillRun[] = [];
  for (const file of files) {
    try {
      const run = JSON.parse(await readFile(join(dir, file), "utf8")) as { versions?: { bench?: string; format?: string }; skill: SkillResult; steps?: TrainStep[] };
      // Sessions saved before the field: the longest step from their steps.
      const result = run.skill.longestStepS === undefined && run.steps ? { ...run.skill, longestStepS: longestStep(run.steps) } : run.skill;
      out.push({ file, bench: run.versions?.bench, format: run.versions?.format, result });
    } catch {
      // still being written
    }
  }
  return out;
}

/** "neo-duel-v8s4 mage-trainee", "random@4000 mage-trainee", "rules mage-trainee". */
export function skillPlayer(r: SkillResult): string {
  const { brain, template, decisionMs } = r.trainee;
  const who = brain === "laya" || brain === "jev" ? (r.model ?? `${brain} (model not recorded)`) : brain;
  return `${who}${decisionMs !== undefined ? `@${decisionMs}` : ""} ${template}`;
}

/** What keeps a session out of the scores, if anything. */
export function skillProblems(r: SkillResult): string[] {
  const problems: string[] = [];
  if (r.errors > 0.02 * Math.max(1, r.decisions + r.errors)) {
    problems.push(`${r.errors} of ${r.decisions + r.errors} decisions failed`);
  }
  if (r.restocks) {
    problems.push(`restocked ${r.restocks} times (a prep fills mana too)`);
  }
  if (r.trainee.decisionMs === undefined && r.trainee.brain !== "rules" && r.latencyMs > BENCH_LATENCY_MS) {
    problems.push(`decisions took ${r.latencyMs} ms (the bench allows ${BENCH_LATENCY_MS} at a player's own pace)`);
  }
  if (r.seconds < r.minutes * 60 - 30) {
    problems.push(`trained ${Math.round(r.seconds / 60)} of ${r.minutes} minutes`);
  }
  // A step is a decision and a cast, a rest or a skill use: seconds, a decision time more at most.
  const allowed = (r.trainee.decisionMs ?? 0) / 1000 + STALL_S;
  if ((r.longestStepS ?? 0) > allowed) {
    problems.push(`a step took ${r.longestStepS} s (the machine or the server froze)`);
  }
  return problems;
}

/** A session's value for a score: the gain in its first minutes, or its minutes to the goal (the cap if never). */
export function skillValue(r: SkillResult, metric: "gain" | "time"): number {
  if (metric === "gain") {
    return mageryAt(r, r.minutes * 60) - r.start.Magery;
  }
  return Math.min(r.cap, (r.reachedAt ?? r.cap * 60) / 60);
}

/** The rows of a bench version's skill tracks: higher gain first, fewer minutes first. */
export function skillLeaderboard(runs: SkillRun[], bench: string, tracks: Record<string, SkillTrack>): SkillRow[] {
  const rows: SkillRow[] = [];
  for (const [name, track] of Object.entries(tracks)) {
    const sessions = runs.filter((r) => r.bench === `${bench}:${name}`);
    const players = new Map<string, SkillResult[]>();
    const flagged = new Map<string, number>();
    for (const { result, format } of sessions) {
      const player = skillPlayer(result);
      // An older format is another test: models read another prompt, scripted players knew other odds.
      const stale = format !== TRAIN_FORMAT;
      if (stale || skillProblems(result).length) {
        flagged.set(player, (flagged.get(player) ?? 0) + 1);
        continue;
      }
      players.set(player, [...(players.get(player) ?? []), result]);
    }
    for (const score of track.scores) {
      const scored: SkillRow[] = [];
      for (const player of new Set([...players.keys(), ...flagged.keys()])) {
        const results = players.get(player) ?? [];
        const { mean, interval } = meanInterval(results.map((r) => skillValue(r, score.metric)));
        scored.push({
          track: score.name,
          metric: score.metric,
          player,
          sessions: results.length,
          flagged: flagged.get(player) ?? 0,
          score: mean,
          interval,
          ...(score.metric === "time" ? { reached: results.filter((r) => r.reachedAt !== null).length } : {}),
          settled: results.length >= MIN_SESSIONS && (interval[1] - interval[0]) / 2 <= score.half_width,
        });
      }
      const sign = score.metric === "gain" ? -1 : 1;
      rows.push(...scored.sort((a, b) => sign * ((a.score || 0) - (b.score || 0))));
    }
  }
  return rows;
}

const fixed = (x: number, digits: number) => (Number.isNaN(x) ? "—" : x.toFixed(digits));

/** The skill rows as Markdown, one table per score. */
export function skillMarkdown(rows: SkillRow[], about: Record<string, string> = {}): string {
  const parts: string[] = [];
  for (const track of [...new Set(rows.map((r) => r.track))]) {
    const own = rows.filter((r) => r.track === track);
    const time = own[0]?.metric === "time";
    parts.push(`## ${track}`, "", ...(about[track] ? [about[track], ""] : []));
    parts.push(
      `| # | player | ${time ? "minutes" : "Magery gained"} | 95% interval | sessions${time ? " (reached)" : ""} | flagged | settled |`,
      "|---|---|---|---|---|---|---|",
    );
    own.forEach((r, k) => {
      parts.push(
        `| ${k + 1} | ${r.player} | ${fixed(r.score, 1)} | ${fixed(r.interval[0], 1)}–${fixed(r.interval[1], 1)} | ${r.sessions}${time ? ` (${r.reached})` : ""} | ${r.flagged} | ${r.settled ? "yes" : "no"} |`,
      );
    });
    parts.push("");
  }
  return parts.join("\n");
}
