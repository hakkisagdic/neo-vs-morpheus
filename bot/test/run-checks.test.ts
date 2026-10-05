import { describe, expect, it } from "vitest";
import type { Decision } from "../src/brain/types.ts";
import { checkRun } from "../src/eval/run-checks.ts";

const rec = (bot: string, brain: string, spell: string, castMs: number, latencyMs = 250, protection = false) => ({
  bot,
  snapshot: { us: { protection } },
  decision: {
    brain, model: brain, latencyMs, inputTokens: 0, outputTokens: 0, module: "mage", mode: { choice: "damage", probabilities: {} },
    parts: {}, plan: { kind: "cast", spell, target: "them" }, why: "", overrides: [],
  } as Decision,
  outcome: { result: "cast", castMs },
});

describe("run checks", () => {
  it("passes casts that take their cast delay", () => {
    const records = Array.from({ length: 6 }, () => rec("Neo", "laya", "magicArrow", 755));
    expect(checkRun(records)).toEqual([{ bot: "Neo", brain: "laya", casts: 6, castDriftMs: 5, slowCasts: 0, latencyMs: 250, problems: [] }]);
  });

  it("flags casts 0.5 s slow, as under a Protection left from an earlier round", () => {
    const records = [
      ...Array.from({ length: 3 }, () => rec("Morpheus", "rules", "explosion", 2_505)),
      ...Array.from({ length: 3 }, () => rec("Morpheus", "rules", "magicArrow", 1_252)),
    ];
    const [check] = checkRun(records);
    expect(check.castDriftMs).toBe(504);
    expect(check.problems[0]).toMatch(/504 ms longer/);
  });

  it("flags a few rounds of slow casts, but not casts under the bot's own Protection", () => {
    const clean = Array.from({ length: 40 }, () => rec("Neo", "laya", "magicArrow", 752));
    const carried = Array.from({ length: 4 }, () => rec("Neo", "laya", "magicArrow", 1_252));
    expect(checkRun([...clean, ...carried])[0].problems[0]).toMatch(/4 of Neo's 44 casts/);
    const own = Array.from({ length: 10 }, () => rec("Neo", "laya", "magicArrow", 1_252, 250, true));
    expect(checkRun([...clean, ...own])[0].problems).toEqual([]);
  });

  it("flags a slow model but not the scripted bot", () => {
    const records = [
      ...Array.from({ length: 5 }, () => rec("Neo", "laya", "harm", 1_000, 1_400)),
      ...Array.from({ length: 5 }, () => rec("Morpheus", "rules", "harm", 1_000, 0)),
    ];
    const problems = checkRun(records).flatMap((c) => c.problems);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Neo took 1400 ms/);
  });

  it("flags a model fighter that never decided, but not a scripted one", () => {
    const records = Array.from({ length: 5 }, () => rec("Morpheus", "rules", "harm", 1_000, 0));
    const fighters = [{ name: "Neo", brain: "laya" }, { name: "Morpheus", brain: "rules" }];
    expect(checkRun(records, fighters).flatMap((c) => c.problems)).toEqual(["Neo (laya) made no decisions (its model server down, or every request timed out?)"]);
    expect(checkRun([], [{ name: "Morpheus", brain: "rules" }, { name: "Trinity", brain: "rules" }])).toEqual([]);
    expect(checkRun([...records, rec("Neo", "laya", "harm", 1_000)], fighters).flatMap((c) => c.problems)).toEqual([]);
  });
});
