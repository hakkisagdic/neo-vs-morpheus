import { describe, expect, it } from "vitest";
import { type SkillTrack, skillLeaderboard, skillPlayer, skillProblems, skillValue } from "../src/bench/skill.ts";
import { meanInterval, t975 } from "../src/bench/stats.ts";
import { type SkillResult, longestStep, mageryAt } from "../src/game/skill-session.ts";
import { TRAIN_FORMAT } from "../src/game/train-brain.ts";

const session = (over: Partial<SkillResult> = {}): SkillResult => ({
  trainee: { name: "Neo", brain: "rules", template: "mage-trainee" },
  minutes: 20,
  goal: 70,
  cap: 60,
  startedAt: 0,
  start: { Magery: 50, Meditation: 50 },
  end: { Magery: 58, Meditation: 55 },
  seconds: 3600,
  reachedAt: null,
  progress: [
    [300, 51],
    [1100, 54],
    [1300, 55],
    [3500, 58],
  ],
  casts: 400,
  fizzles: 100,
  restocks: 0,
  errors: 0,
  decisions: 900,
  latencyMs: 0,
  choices: { "cast:4": 400, meditate: 500 },
  ...over,
});

const TRACKS: Record<string, SkillTrack> = {
  "ml/skill-magery": {
    kind: "skill",
    minutes: 20,
    goal: 70,
    cap: 60,
    scores: [
      { name: "gain", metric: "gain", half_width: 0.5 },
      { name: "time", metric: "time", half_width: 2 },
    ],
  },
};

describe("UO Bench skill tracks", () => {
  it("reads Magery at a time from a session's progress", () => {
    expect(mageryAt(session(), 0)).toBe(50);
    expect(mageryAt(session(), 1200)).toBe(54);
    expect(skillValue(session(), "gain")).toBe(4);
    expect(skillValue(session(), "time")).toBe(60); // never reached: the cap
    expect(skillValue(session({ reachedAt: 2700 }), "time")).toBe(45);
  });

  it("names the player as the duel tracks do", () => {
    expect(skillPlayer(session())).toBe("rules mage-trainee");
    expect(skillPlayer(session({ trainee: { name: "Neo", brain: "laya", template: "mage-trainee" }, model: "neo-duel-v8s4" }))).toBe("neo-duel-v8s4 mage-trainee");
    expect(skillPlayer(session({ trainee: { name: "Neo", brain: "jev", template: "mage-trainee", decisionMs: 4000 }, model: "jev-1" }))).toBe("jev-1@4000 mage-trainee");
  });

  it("leaves out sessions with failed decisions, a restock, slow decisions or cut short", () => {
    expect(skillProblems(session())).toEqual([]);
    expect(skillProblems(session({ errors: 50 }))).toHaveLength(1);
    expect(skillProblems(session({ restocks: 1 }))).toHaveLength(1);
    expect(skillProblems(session({ trainee: { name: "Neo", brain: "laya", template: "mage-trainee" }, latencyMs: 350 }))).toHaveLength(1);
    expect(skillProblems(session({ trainee: { name: "Neo", brain: "laya", template: "mage-trainee", decisionMs: 4000 }, latencyMs: 3900 }))).toEqual([]);
    expect(skillProblems(session({ seconds: 600 }))).toHaveLength(1);
    expect(skillProblems(session({ longestStepS: 900 }))).toEqual(["a step took 900 s (the machine or the server froze)"]);
    expect(skillProblems(session({ longestStepS: 33, trainee: { name: "Neo", brain: "jev", template: "mage-trainee", decisionMs: 4000 } }))).toEqual([]);
    const steps = [0, 3, 6.5, 970, 973].map((seconds) => ({ state: { seconds } })) as Parameters<typeof longestStep>[0];
    expect(longestStep(steps)).toBe(964);
  });

  it("ranks gains high to low and times low to high, and settles only with enough sessions", () => {
    const runs = [
      ...Array.from({ length: 30 }, (_, i) => ({ file: `a${i}`, bench: "uo-bench/1:ml/skill-magery", format: TRAIN_FORMAT, result: session({ progress: [[600, 54 + (i % 3) * 0.1]] }) })),
      ...Array.from({ length: 5 }, (_, i) => ({
        file: `b${i}`,
        bench: "uo-bench/1:ml/skill-magery",
        format: TRAIN_FORMAT,
        result: session({ trainee: { name: "Neo", brain: "random", template: "mage-trainee" }, progress: [[600, 51]], reachedAt: i ? null : 1800 }),
      })),
      { file: "c", bench: "uo-bench/1:ml/skill-magery", format: TRAIN_FORMAT, result: session({ restocks: 2 }) },
      { file: "e", bench: "uo-bench/1:ml/skill-magery", format: "skill-2", result: session() }, // an older test
      { file: "d", bench: "uo-bench/1:ml/duel-mage", result: session() },
    ];
    const rows = skillLeaderboard(runs, "uo-bench/1", TRACKS);
    const gain = rows.filter((r) => r.track === "gain");
    expect(gain.map((r) => r.player)).toEqual(["rules mage-trainee", "random mage-trainee"]);
    expect(gain[0].score).toBeCloseTo(4.1);
    expect(gain[0].sessions).toBe(30);
    expect(gain[0].flagged).toBe(2);
    expect(gain[0].settled).toBe(true);
    expect(gain[1].settled).toBe(false); // 5 sessions
    const time = rows.filter((r) => r.track === "time");
    expect(time[0].player).toBe("random mage-trainee"); // one session got there in 30 min
    expect(time[0].score).toBeCloseTo((30 + 4 * 60) / 5);
    expect(time[0].reached).toBe(1);
  });

  it("gives Student's t and an interval of a mean no narrower than t's", () => {
    expect(t975(1)).toBeCloseTo(12.706);
    expect(t975(11)).toBeCloseTo(2.201, 2);
    expect(t975(60)).toBeCloseTo(2.0, 2);
    const { mean, interval } = meanInterval([4, 5, 6, 5, 4, 6, 5, 5]);
    expect(mean).toBe(5);
    const half = (t975(7) * Math.sqrt(4 / 7)) / Math.sqrt(8);
    expect(interval[0]).toBeLessThanOrEqual(5 - half + 1e-9);
    expect(interval[1]).toBeGreaterThanOrEqual(5 + half - 1e-9);
    expect(meanInterval([3]).interval[0]).toBeNaN();
  });
});
