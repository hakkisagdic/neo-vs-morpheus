import { describe, expect, it } from "vitest";
import { leaderboard, leaderboardMarkdown } from "../src/bench/leaderboard.ts";
import type { RunInfo } from "../src/fleet/results.ts";

const run = (bench: string | undefined, sides: string[], wins: number[], draws = 0, problems: string[] = []): RunInfo =>
  ({ file: "x", instance: "mac", startedAt: 0, arena: "open 8", sides, wins, draws, problems, bench, summary: {} }) as unknown as RunInfo;

describe("UO Bench leaderboard", () => {
  it("scores the side that is not the scripted opponent, by track, from bench runs only", () => {
    const rows = leaderboard(
      [
        run("uo-bench/1:ml/duel-mage", ["neo-duel-v8 mage", "rules@40 mage"], [7, 3]),
        run("uo-bench/1:ml/duel-mage", ["rules@40 mage", "neo-duel-v8 mage"], [4, 5], 1),
        run("uo-bench/1:ml/duel-mage", ["random mage", "rules@40 mage"], [1, 9]),
        run("uo-bench/1:ml/duel-mage", ["neo-duel-v8 mage", "rules@40 mage"], [0, 10], 0, ["late casts"]),
        run(undefined, ["neo-duel-v8 mage", "rules@40 mage"], [10, 0]),
        run("uo-bench/2:ml/duel-mage", ["neo-duel-v8 mage", "rules@40 mage"], [10, 0]),
      ],
      "uo-bench/1",
    );
    expect(rows.map((r) => [r.player, r.rounds, r.runs, r.flagged, r.score])).toEqual([
      ["neo-duel-v8 mage", 20, 2, 1, 12.5 / 20],
      ["random mage", 10, 1, 0, 0.1],
    ]);
    expect(rows[0].settled).toBe(false);
    expect(leaderboardMarkdown(rows, "uo-bench/1")).toContain("| 1 | neo-duel-v8 mage | 62.5 |");
  });
});
