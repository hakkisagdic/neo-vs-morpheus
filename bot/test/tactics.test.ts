import { describe, expect, it } from "vitest";
import { NEUTRAL, applyAggression, applyBands, parseTactics } from "../src/brain/tactics.ts";

const MAGE = ["damage:explosion", "damage:magicArrow", "defense:heal", "defense:greaterHeal", "defense:cure", "defense:retreat"];

describe("tactics files", () => {
  it("keeps what it knows, clamps it, and leaves the rest neutral", () => {
    const t = parseTactics({ aggression: 3, heal: [80, 30], chase: { maxTiles: 12 }, surprise: true }, "mine");
    expect(t.aggression).toBe(1);
    expect(t.heal).toEqual([30, 80]);
    expect(t.chase).toEqual({ ...NEUTRAL.chase, maxTiles: 12 });
    expect(t.retreat).toEqual(NEUTRAL.retreat);
  });
});

describe("bands", () => {
  const t = parseTactics({ heal: [35, 70], retreat: [0, 40] });

  it("require healing under the floor, cures still allowed", () => {
    expect(applyBands(MAGE, 20, t).options).toEqual(["defense:heal", "defense:greaterHeal", "defense:cure"]);
  });

  it("take healing and retreating away above the ceiling", () => {
    expect(applyBands(MAGE, 90, t).options).toEqual(["damage:explosion", "damage:magicArrow", "defense:cure"]);
  });

  it("leave the model to decide in between", () => {
    expect(applyBands(MAGE, 38, t).options).toEqual(MAGE);
    expect(applyBands(MAGE, 38, NEUTRAL).options).toEqual(MAGE);
  });

  it("never leave the question empty", () => {
    expect(applyBands(["defense:heal"], 90, t).options).toEqual(["defense:heal"]);
  });
});

describe("aggression", () => {
  const p = { "damage:explosion": 0.3, "damage:magicArrow": 0.3, "defense:greaterHeal": 0.4 };

  it("changes nothing at zero", () => {
    expect(applyAggression(p, 0)).toBe(p);
  });

  it("moves weight towards attacks when aggressive and away when cautious", () => {
    const bold = applyAggression(p, 0.6);
    const shy = applyAggression(p, -0.6);
    expect(bold["defense:greaterHeal"]).toBeLessThan(0.4);
    expect(shy["defense:greaterHeal"]).toBeGreaterThan(0.4);
    expect(Object.values(bold).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(bold["damage:explosion"]).toBeCloseTo(bold["damage:magicArrow"]);
  });
});

describe("tactics in the duel", async () => {
  const { compositeQuestion, resolvePlan, tacticalOptions } = await import("../src/brain/duel-policy.ts");
  const { legalMeleeOptions } = await import("../src/brain/melee-policy.ts");
  const snap = (distance: number, hits = 90, outOfReachForMs = 0, extra: Record<string, unknown> = {}) =>
    ({
      now: 0,
      us: {
        name: "Neo", serial: 1, hits, hitsMax: 100, mana: 100, manaMax: 100, stam: 100, stamMax: 100, poisoned: false,
        x: 0, y: 0, z: 0, readyInMs: 0, lastSpell: null, lastSpellAgoMs: 0, outOfReachForMs, ...extra,
      },
      them: {
        name: "Morpheus", serial: 2, healthPct: 80, poisoned: false, x: distance, y: 0, z: 0, dead: false, casting: null,
        castingForMs: 0, landsInMs: 0, distance, inLineOfSight: true, inRange: distance <= 10, weapon: null,
      },
      reagents: { blackPearl: 9, bloodmoss: 9, garlic: 9, ginseng: 9, mandrakeRoot: 9, nightshade: 9, sulfurousAsh: 9, spidersSilk: 9 },
      tiles: [],
      recent: [],
    }) as never;
  const t = parseTactics({ chase: { maxTiles: 14, giveUpSeconds: 5, teleport: false }, heal: [35, 70] });

  it("does not chase past the limit or after giving up, and waits instead", () => {
    expect(tacticalOptions(snap(12), t).options).toContain("damage:chase");
    expect(tacticalOptions(snap(16), t).options).not.toContain("damage:chase");
    expect(tacticalOptions(snap(12, 90, 6_000), t).notes[0]).toMatch(/given up after 5 s/);
    const overrides: string[] = [];
    const { plan } = resolvePlan(
      snap(16),
      { choice: "damage", probabilities: { damage: 1, interrupt: 0, defense: 0 } },
      { damage: { choice: "chase", probabilities: { chase: 1 } }, interrupt: { choice: "", probabilities: {} }, defense: { choice: "", probabilities: {} } },
      undefined,
      overrides,
      t,
    );
    expect(plan.kind).toBe("wait");
  });

  it("walks instead of teleporting when teleporting is off", () => {
    const s = snap(12) as unknown as { tiles: unknown[] };
    s.tiles = [{ id: "p1", x: 11, y: 0, z: 0, label: "next to Morpheus" }];
    const mode = { choice: "damage", probabilities: { damage: 1, interrupt: 0, defense: 0 } };
    const byMode = { damage: { choice: "chase", probabilities: { chase: 1 } }, interrupt: { choice: "", probabilities: {} }, defense: { choice: "", probabilities: {} } };
    expect(resolvePlan(s as never, mode, byMode, undefined, [], NEUTRAL).plan.kind).toBe("teleport");
    expect(resolvePlan(s as never, mode, byMode, undefined, [], t).plan.kind).toBe("approach");
  });

  it("asks only for heals under the heal band's floor", () => {
    const options = Object.keys(compositeQuestion(snap(5, 20), t).move.criteria);
    expect(options.every((k) => k === "defense:heal" || k === "defense:greaterHeal")).toBe(true);
  });

  it("applies fighters' bands and explosion range", () => {
    const fighter = snap(5, 20, 0, {
      weapon: { name: "katana", ranged: false, range: 1, primary: "doubleStrike", primaryMana: 25, secondary: "armorIgnore", secondaryMana: 25 },
      freeHand: true, bandagingForMs: 0, healPotionReadyInMs: 0,
    }) as unknown as { supplies: unknown };
    fighter.supplies = { bandages: 10, healPotions: 5, curePotions: 5, refreshPotions: 5, explosionPotions: 5, arrows: 0 };
    const tight = parseTactics({ healPotion: [30, 60], explosionRange: [6, 8] });
    const options = Object.keys(legalMeleeOptions(fighter as never, tight));
    expect(options).toEqual(["heal:potion"]);
    const f = fighter as unknown as { us: object };
    const calm = Object.keys(legalMeleeOptions({ ...f, us: { ...f.us, hits: 50 } } as never, tight));
    expect(calm).not.toContain("throw:explosion");
  });
});
