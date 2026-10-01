import { describe, expect, it } from "vitest";
import type { Decision, DuelSnapshot } from "../src/brain/types.ts";
import { type Run, type RunRecord, outcomeLabels, scoreRun, splitRounds, takenKey } from "../src/distill/outcomes.ts";

const snapshot = (hits: number, theirs: number, distance = 5): DuelSnapshot => ({
  now: 0,
  us: {
    name: "Neo", serial: 1, hits, hitsMax: 100, mana: 100, manaMax: 100, stam: 50, stamMax: 50, poisoned: false,
    x: 0, y: 0, z: 0, readyInMs: 0, lastSpell: null, lastSpellAgoMs: 0,
  },
  them: {
    name: "Morpheus", serial: 2, healthPct: theirs, poisoned: false, x: distance, y: 0, z: 0, dead: false, casting: null,
    castingForMs: 0, landsInMs: 0, distance, inLineOfSight: true, inRange: distance <= 10,
  },
  reagents: { blackPearl: 9, bloodmoss: 9, garlic: 9, ginseng: 9, mandrakeRoot: 9, nightshade: 9, sulfurousAsh: 9, spidersSilk: 9 },
  tiles: [],
  recent: [],
});

const decision = (plan: Decision["plan"], mode = "damage"): Decision => ({
  brain: "rules", model: "rules", latencyMs: 0, inputTokens: 0, outputTokens: 0, module: "mage",
  mode: { choice: mode, probabilities: { [mode]: 1 } }, parts: {}, plan, why: "", overrides: [],
});

const rec = (at: number, bot: string, hits: number, theirs: number, plan: Decision["plan"], mode?: string): RunRecord => ({
  at, bot, decision: decision(plan, mode), snapshot: snapshot(hits, theirs),
});

describe("scoring recorded decisions", () => {
  it("splits rounds at the setup gaps", () => {
    const records = [0, 1000, 2000, 9000, 10000, 20000].map((at) => rec(at, "Neo", 100, 100, { kind: "wait", ms: 300 }));
    expect(splitRounds(records, 3).map((r) => r.length)).toEqual([3, 2, 1]);
  });

  it("names the move a plan carried out", () => {
    const s = snapshot(90, 90);
    expect(takenKey(decision({ kind: "cast", spell: "explosion", target: "them" }), s)).toBe("damage:explosion");
    expect(takenKey(decision({ kind: "cast", spell: "magicArrow", target: "them" }, "interrupt"), s)).toBe("interrupt:magicArrow");
    expect(takenKey(decision({ kind: "cast", spell: "greaterHeal", target: "self" }, "defense"), s)).toBe("defense:greaterHeal");
    expect(takenKey(decision({ kind: "approach" }), snapshot(90, 90, 13))).toBe("damage:chase");
    expect(takenKey(decision({ kind: "wait", ms: 300 }), s)).toBeNull();
  });

  it("keeps the moves that did clearly better than average, as sharpened targets", () => {
    // Neo's Explosion takes 40 of Morpheus's health and the round is won; the Harms after it do nothing.
    const run: Run = {
      match: { results: [{ winner: "Neo" }] },
      records: [
        rec(0, "Neo", 100, 100, { kind: "cast", spell: "explosion", target: "them" }),
        rec(4_600, "Neo", 100, 60, { kind: "cast", spell: "harm", target: "them" }),
        rec(9_000, "Neo", 100, 60, { kind: "cast", spell: "harm", target: "them" }),
      ],
    };
    const scored = scoreRun("r.json", run);
    expect(scored[0].ret).toBeGreaterThan(scored[1].ret);
    const rows = outcomeLabels(scored);
    expect(rows).toHaveLength(1);
    expect(rows[0].teacher.probabilities["damage:explosion"]).toBeCloseTo(0.8);
    expect(rows[0].format.question).toBe("composite-4");
  });
});
