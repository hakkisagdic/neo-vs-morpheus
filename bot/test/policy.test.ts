import { describe, expect, it } from "vitest";
import { blocked, resolvePlan, splitComposite } from "../src/brain/duel-policy.ts";
import type { DuelSnapshot } from "../src/brain/types.ts";

const snapshot = (over: Partial<{ poisoned: boolean; mana: number; casting: string | null; themPoisoned: boolean }> = {}): DuelSnapshot => ({
  now: 0,
  us: { name: "Neo", serial: 1, hits: 60, hitsMax: 100, mana: over.mana ?? 100, manaMax: 100, stam: 50, stamMax: 50, poisoned: over.poisoned ?? false, x: 0, y: 0, z: 0, readyInMs: 0, lastSpell: null, lastSpellAgoMs: 0 },
  them: { name: "Morpheus", serial: 2, healthPct: 50, poisoned: over.themPoisoned ?? false, x: 5, y: 0, z: 0, dead: false, casting: over.casting ?? null, castingForMs: 0, landsInMs: 1000, distance: 5, inLineOfSight: true, inRange: true },
  reagents: { blackPearl: 9, bloodmoss: 9, garlic: 9, ginseng: 9, mandrakeRoot: 9, nightshade: 9, sulfurousAsh: 9, spidersSilk: 9 },
  tiles: [],
  recent: [],
});

describe("composite answers", () => {
  it("splits into mode totals and renormalised per-mode spells", () => {
    const parts = splitComposite({
      choice: "damage:explosion",
      probabilities: { "damage:explosion": 0.5, "damage:harm": 0.1, "interrupt:magicArrow": 0.3, "defense:cure": 0.1 },
    });
    expect(parts.mode.choice).toBe("damage");
    expect(parts.mode.probabilities.damage).toBeCloseTo(0.6);
    expect(parts.interrupt.probabilities.magicArrow).toBeCloseTo(1);
    expect(parts.damage.probabilities.explosion).toBeCloseTo(0.5 / 0.6);
  });
});

describe("guardrails", () => {
  it("never cures when not poisoned and never poisons a poisoned target", () => {
    expect(blocked("cure", snapshot())).toMatch(/not poisoned/);
    expect(blocked("poison", snapshot({ themPoisoned: true }))).toMatch(/already poisoned/);
    expect(blocked("explosion", snapshot({ mana: 10 }))).toMatch(/mana/);
  });

  it("falls back to the next usable option and records why", () => {
    const overrides: string[] = [];
    const one = (k: string) => ({ choice: k, probabilities: { [k]: 0.9, other: 0.1 } });
    const { plan } = resolvePlan(
      snapshot(),
      { choice: "defense", probabilities: { defense: 0.7, damage: 0.3, interrupt: 0 } },
      { damage: { choice: "lightning", probabilities: { lightning: 1 } }, interrupt: one("harm"), defense: { choice: "cure", probabilities: { cure: 0.8, heal: 0.2 } } },
      undefined,
      overrides,
    );
    expect(plan).toEqual({ kind: "cast", spell: "heal", target: "self" });
    expect(overrides[0]).toMatch(/cure → heal/);
  });

  it("does not interrupt an opponent who is not casting", () => {
    const overrides: string[] = [];
    const { plan } = resolvePlan(
      snapshot({ casting: null }),
      { choice: "interrupt", probabilities: { interrupt: 0.9, damage: 0.1, defense: 0 } },
      { damage: { choice: "lightning", probabilities: { lightning: 1 } }, interrupt: { choice: "harm", probabilities: { harm: 1 } }, defense: { choice: "heal", probabilities: { heal: 1 } } },
      undefined,
      overrides,
    );
    expect(plan).toEqual({ kind: "cast", spell: "lightning", target: "them" });
  });
});
