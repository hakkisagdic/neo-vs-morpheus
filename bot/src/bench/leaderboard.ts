// UO Bench's leaderboard: every player's score on every track of a bench version, from the runs
// tagged with it (versions.bench, "uo-bench/1:ml/duel-mage"), with intervals from bench/stats.ts.
import type { RunInfo } from "../fleet/results.ts";
import { type RunScore, bootstrapInterval, share, wilson } from "./stats.ts";

export type BenchRow = {
  track: string;
  /** What played: a checkpoint, "random", "jev", or the base model, with the build ("neo-duel-v8 mage"). */
  player: string;
  rounds: number;
  runs: number;
  /** Runs a run check flagged (slow decisions, late casts, a silent model), or too slow for the bench: left out. */
  flagged: number;
  score: number;
  interval: [number, number];
  /** Wilson's interval for the same rounds taken as independent, narrower than the honest one. */
  wilson: [number, number];
  /** The interval is within the bench's half-width either way, over at least MIN_ROUNDS rounds. */
  settled: boolean;
};

const scripted = (side: string) => /^rules@\d+ /.test(side);

/** Rounds below which no score counts as settled, however narrow its interval looks. */
export const MIN_ROUNDS = 400;
/**
 * A player at its own pace must decide this quickly (median) for its run to count: past ~200 ms
 * speed starts deciding duels (the scripted bot against slower copies of itself: no effect up to
 * 200 ms, 69% at 250 ms), and the bench measures judgement at matched speed.
 */
export const BENCH_LATENCY_MS = 200;

/**
 * The rows of one bench version, by track and then best score first. opponents: a track's opponent
 * as a side reads ("neo-duel-v8r-s2 mage") when it is not the scripted bot (a sparring model).
 */
export function leaderboard(runs: RunInfo[], bench: string, halfWidth = 0.03, opponents: Record<string, string> = {}): BenchRow[] {
  const groups = new Map<string, { track: string; player: string; scores: RunScore[]; flagged: number }>();
  for (const run of runs) {
    if (!run.bench?.startsWith(`${bench}:`) || run.sides.length !== 2) {
      continue;
    }
    // The player is the side that is not the track's opponent (the scripted bot, or a sparring
    // model); a model against itself, or two players (a ladder), is not a duel track's run.
    const track = run.bench.slice(bench.length + 1);
    const opponent = (side: string) => (opponents[track] ? side === opponents[track] : scripted(side));
    const i = opponent(run.sides[1]) && !opponent(run.sides[0]) ? 0 : opponent(run.sides[0]) && !opponent(run.sides[1]) ? 1 : -1;
    if (i < 0) {
      continue;
    }
    const key = `${track}|${run.sides[i]}`;
    const group = groups.get(key) ?? { track, player: run.sides[i], scores: [], flagged: 0 };
    groups.set(key, group);
    const name = run.summary?.fighters[i]?.name;
    const latency = name !== undefined ? run.summary?.latencyMs[name] : undefined;
    const paced = run.sides[i].split(" ")[0].includes("@");
    if (run.problems.length || (!paced && latency !== undefined && latency > BENCH_LATENCY_MS)) {
      group.flagged++;
      continue;
    }
    const rounds = run.wins[0] + run.wins[1] + run.draws;
    if (rounds) {
      group.scores.push({ points: run.wins[i] + run.draws / 2, rounds });
    }
  }
  const rows = [...groups.values()].map(({ track, player, scores, flagged }): BenchRow => {
    const rounds = scores.reduce((n, s) => n + s.rounds, 0);
    const independent = wilson(scores.reduce((n, s) => n + s.points, 0), rounds);
    // A bootstrap over few runs, or runs that all ended alike, can collapse to a point; the wider of
    // it and Wilson's interval is the one reported.
    const boot = bootstrapInterval(scores);
    const interval: [number, number] = Number.isNaN(boot[0]) ? independent : [Math.min(boot[0], independent[0]), Math.max(boot[1], independent[1])];
    return {
      track,
      player,
      rounds,
      runs: scores.length,
      flagged,
      score: share(scores),
      interval,
      wilson: independent,
      settled: rounds >= MIN_ROUNDS && (interval[1] - interval[0]) / 2 <= halfWidth,
    };
  });
  return rows.sort((a, b) => a.track.localeCompare(b.track) || (b.score || 0) - (a.score || 0));
}

const pct = (x: number) => (Number.isNaN(x) ? "—" : `${(100 * x).toFixed(1)}`);

/** The leaderboard as Markdown, one table per track. */
export function leaderboardMarkdown(rows: BenchRow[], bench: string, about: Record<string, string> = {}): string {
  const tracks = [...new Set(rows.map((r) => r.track))];
  const parts = [`# ${bench} leaderboard`, "", "Score: share of points (win 1, draw 1/2) against the track's opponent; 95% interval from a bootstrap over runs; settled when within ±3 points.", ""];
  for (const track of tracks) {
    parts.push(`## ${track}`, "", ...(about[track] ? [about[track], ""] : []));
    parts.push("| # | player | score | 95% interval | rounds (runs) | flagged | settled |", "|---|---|---|---|---|---|---|");
    rows.filter((r) => r.track === track).forEach((r, k) => {
      parts.push(`| ${k + 1} | ${r.player} | ${pct(r.score)} | ${pct(r.interval[0])}–${pct(r.interval[1])} | ${r.rounds} (${r.runs}) | ${r.flagged} | ${r.settled ? "yes" : "no"} |`);
    });
    parts.push("");
  }
  return parts.join("\n");
}
