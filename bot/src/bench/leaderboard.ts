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
  /** Runs a run check flagged (slow decisions, late casts, a silent model): left out. */
  flagged: number;
  score: number;
  interval: [number, number];
  /** Wilson's interval for the same rounds taken as independent, narrower than the honest one. */
  wilson: [number, number];
  /** The interval is within the bench's half-width either way. */
  settled: boolean;
};

const scripted = (side: string) => /^rules@\d+ /.test(side);

/** The rows of one bench version, by track and then best score first. */
export function leaderboard(runs: RunInfo[], bench: string, halfWidth = 0.03): BenchRow[] {
  const groups = new Map<string, { track: string; player: string; scores: RunScore[]; flagged: number }>();
  for (const run of runs) {
    if (!run.bench?.startsWith(`${bench}:`) || run.sides.length !== 2) {
      continue;
    }
    // The player is the side that is not the bench's scripted opponent; a ladder (two players) is not a duel track.
    const i = scripted(run.sides[1]) && !scripted(run.sides[0]) ? 0 : scripted(run.sides[0]) && !scripted(run.sides[1]) ? 1 : -1;
    if (i < 0) {
      continue;
    }
    const track = run.bench.slice(bench.length + 1);
    const key = `${track}|${run.sides[i]}`;
    const group = groups.get(key) ?? { track, player: run.sides[i], scores: [], flagged: 0 };
    groups.set(key, group);
    if (run.problems.length) {
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
    const interval = bootstrapInterval(scores);
    return {
      track,
      player,
      rounds,
      runs: scores.length,
      flagged,
      score: share(scores),
      interval,
      wilson: wilson(scores.reduce((n, s) => n + s.points, 0), rounds),
      settled: (interval[1] - interval[0]) / 2 <= halfWidth,
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
