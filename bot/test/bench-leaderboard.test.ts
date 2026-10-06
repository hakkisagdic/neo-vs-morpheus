import { describe, expect, it } from "vitest";
import { leaderboard, leaderboardMarkdown } from "../src/bench/leaderboard.ts";
import type { RunInfo } from "../src/fleet/results.ts";

const run = (bench: string | undefined, sides: string[], wins: number[], draws = 0, problems: string[] = [], latencyMs = 50): RunInfo =>
  ({
    file: "x", instance: "mac", startedAt: 0, arena: "open 8", sides, wins, draws, problems, bench,
    summary: { fighters: [{ name: "Neo" }, { name: "Morpheus" }], latencyMs: { Neo: latencyMs, Morpheus: latencyMs } },
  }) as unknown as RunInfo;

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
    // Runs that all ended alike do not make a narrow interval: Wilson's floor keeps it honest.
    const alike = leaderboard(Array.from({ length: 3 }, () => run("uo-bench/1:ml/duel-dexer", ["laya-base dexer", "rules@40 dexer"], [0, 10])), "uo-bench/1");
    expect(alike[0].interval[1]).toBeGreaterThan(0.1);
    expect(alike[0].settled).toBe(false);
    // A player slower than the bench allows is left out at its usual pace, not at a pace of its own.
    const slow = leaderboard(
      [
        run("uo-bench/1:ml/duel-mage", ["neo-duel-v8 mage", "rules@40 mage"], [9, 1], 0, [], 350),
        run("uo-bench/1:ml/equal-mage", ["jev@4000 mage", "rules@4000 mage"], [6, 4], 0, [], 4100),
      ],
      "uo-bench/1",
    );
    expect(slow.map((r) => [r.player, r.runs, r.flagged])).toEqual([["neo-duel-v8 mage", 0, 1], ["jev@4000 mage", 1, 0]]);
    expect(leaderboardMarkdown(rows, "uo-bench/1")).toContain("| 1 | neo-duel-v8 mage | 62.5 |");
  });
});
