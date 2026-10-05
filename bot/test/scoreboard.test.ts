import { describe, expect, it } from "vitest";
import type { Row } from "../src/fleet/results.ts";
import { parseSide, scoreboard } from "../src/fleet/scoreboard.ts";

const row = (a: string, b: string, wins: [number, number], runs = 1, flagged = 0, draws = 0): Row => ({
  matchup: `${a} vs ${b}`, sides: [a, b], wins, draws, runs, flagged,
});

describe("scoreboard", () => {
  it("reads a side: what decides, the build and the tactics", () => {
    expect(parseSide("neo-duel-v8 mage heal-first")).toEqual({ who: "neo-duel-v8", template: "mage", tactics: "heal-first" });
    expect(parseSide("rules@40 dexer")).toEqual({ who: "rules@40", template: "dexer", tactics: undefined });
    expect(parseSide("laya (model not recorded) mage explore")).toMatchObject({ who: "laya (model not recorded)", template: "mage", tactics: "explore" });
  });

  it("scores each checkpoint and profile against the scripted bot at matched speed, by build, either seating", () => {
    const board = scoreboard([
      row("neo-duel-v8 mage", "rules@40 mage", [30, 20], 5),
      row("rules@60 mage", "neo-duel-v8 mage", [10, 15], 3, 1),
      row("neo-duel-v8 mage heal-first", "rules@40 mage", [12, 18], 3),
      row("neo-duel-v9a dexer", "rules@40 dexer", [8, 2], 1),
    ]);
    expect(board.columns).toEqual(["mage", "dexer"]);
    expect(board.rows.map((r) => [r.model, r.tactics])).toEqual([["neo-duel-v9a", undefined], ["neo-duel-v8", undefined], ["neo-duel-v8", "heal-first"]]);
    expect(board.rows[1].cells.mage).toEqual({ wins: 45, losses: 30, draws: 0, runs: 8, flagged: 1 });
    expect(board.collection).toEqual([]);
  });

  it("counts exploration, the scripted bot's own games and slower or tuned opponents as data collection", () => {
    const board = scoreboard([
      row("neo-duel-v8 mage explore", "rules@100 mage", [10, 60], 7, 2),
      row("rules@100 archer cautious", "rules@100 dexer", [5, 4], 2),
      row("neo-duel-v8 mage", "rules@100 mage", [6, 4], 1),
      row("npc EvilMageLord", "rules@0 mage", [0, 1], 1),
      row("laya (model not recorded) mage", "rules@40 mage", [0, 0], 0, 4),
    ]);
    expect(board.rows).toEqual([]);
    expect(board.collection).toEqual([
      { kind: "exploration", runs: 7, rounds: 70, flagged: 2, models: ["neo-duel-v8"] },
      { kind: "scripted", runs: 2, rounds: 9, flagged: 0, models: [] },
      { kind: "other", runs: 2, rounds: 11, flagged: 4, models: ["neo-duel-v8"] },
    ]);
  });
});
