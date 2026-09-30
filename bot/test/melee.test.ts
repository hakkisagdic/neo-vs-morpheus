import { describe, expect, it } from "vitest";
import {
  blockedMelee,
  describeMelee,
  meleeBaseline,
  meleeOptions,
  resolveMeleePlan,
  splitByMode,
} from "../src/brain/melee-policy.ts";
import type { DuelSnapshot } from "../src/brain/types.ts";

type Over = {
  hits?: number;
  mana?: number;
  stam?: number;
  poisoned?: boolean;
  distance?: number;
  bandaging?: number;
  healReady?: number;
  heal?: number;
  explosion?: number;
};

const fighter = (o: Over = {}): DuelSnapshot => ({
  now: 0,
  us: {
    name: "Neo", serial: 1, hits: o.hits ?? 100, hitsMax: 100, mana: o.mana ?? 25, manaMax: 25, stam: o.stam ?? 100, stamMax: 100,
    poisoned: o.poisoned ?? false, x: 0, y: 0, z: 0, readyInMs: 0, lastSpell: null, lastSpellAgoMs: 0,
    weapon: { name: "katana", ranged: false, range: 1, primary: "doubleStrike", primaryMana: 25, secondary: "armorIgnore", secondaryMana: 25 },
    bandagingForMs: o.bandaging ?? 0,
    healPotionReadyInMs: o.healReady ?? 0,
    lastAbilityAgoMs: Number.POSITIVE_INFINITY,
  },
  them: {
    name: "Morpheus", serial: 2, healthPct: 80, poisoned: false, x: o.distance ?? 1, y: 0, z: 0, dead: false, casting: null,
    castingForMs: 0, landsInMs: 0, distance: o.distance ?? 1, inLineOfSight: true, inRange: true, weapon: null,
  },
  supplies: { bandages: 50, healPotions: o.heal ?? 5, curePotions: 5, refreshPotions: 5, explosionPotions: o.explosion ?? 5, arrows: 0 },
  reagents: {},
  tiles: [],
  recent: [],
});

const one = (key: string) => ({ choice: key, probabilities: { [key]: 0.9, "attack:swing": 0.1 } });

describe("melee guardrails", () => {
  it("drinks a cure only when poisoned and a heal only when hurt and ready", () => {
    expect(blockedMelee("cure:potion", fighter())).toMatch(/not poisoned/);
    expect(blockedMelee("cure:potion", fighter({ poisoned: true }))).toBeNull();
    expect(blockedMelee("heal:potion", fighter())).toMatch(/full health/);
    expect(blockedMelee("heal:potion", fighter({ hits: 40, healReady: 3_000 }))).toMatch(/not ready/);
    expect(blockedMelee("heal:potion", fighter({ hits: 40, heal: 0 }))).toMatch(/no heal/);
  });

  it("does not start a second bandage or a special move without the mana", () => {
    expect(blockedMelee("heal:bandage", fighter({ hits: 60, bandaging: 2_000 }))).toMatch(/already/);
    expect(blockedMelee("attack:secondary", fighter({ mana: 10 }))).toMatch(/mana/);
    expect(blockedMelee("attack:secondary", fighter())).toBeNull();
  });

  it("throws explosions only from a safe distance and within reach", () => {
    expect(blockedMelee("throw:explosion", fighter({ distance: 1 }))).toMatch(/too close/);
    expect(blockedMelee("throw:explosion", fighter({ distance: 12 }))).toMatch(/range/);
    expect(blockedMelee("throw:explosion", fighter({ distance: 4 }))).toBeNull();
  });

  it("falls back to the next usable move and says why", () => {
    const overrides: string[] = [];
    const { plan } = resolveMeleePlan(fighter(), one("cure:potion"), overrides);
    expect(plan).toEqual({ kind: "attack" });
    expect(overrides[0]).toMatch(/cure:potion → attack:swing/);
  });

  it("offers no potions without a free hand, and bandages when poisoned", () => {
    const archer = fighter({ poisoned: true, hits: 90 });
    archer.us.freeHand = false;
    const options = Object.keys(meleeOptions(archer));
    expect(options.some((k) => k.endsWith(":potion") || k.startsWith("throw:"))).toBe(false);
    expect(meleeBaseline(archer)).toBe("heal:bandage");
  });

  it("offers explosion potions only to fighters who carry them", () => {
    expect("throw:explosion" in meleeOptions(fighter())).toBe(true);
    expect("throw:explosion" in meleeOptions(fighter({ explosion: 0 }))).toBe(false);
  });
});

describe("scripted fighter", () => {
  it("cures, heals, bandages, then hits with its ability", () => {
    expect(meleeBaseline(fighter({ poisoned: true, hits: 70 }))).toBe("cure:potion");
    expect(meleeBaseline(fighter({ hits: 30 }))).toBe("heal:potion");
    expect(meleeBaseline(fighter({ hits: 70 }))).toBe("heal:bandage");
    expect(meleeBaseline(fighter())).toBe("attack:secondary");
    expect(meleeBaseline(fighter({ mana: 5 }))).toBe("attack:swing");
  });
});

describe("state and answers", () => {
  it("describes weapon, supplies and reach", () => {
    const text = describeMelee(fighter({ distance: 4, bandaging: 2_500 }));
    expect(text).toMatch(/katana/);
    expect(text).toMatch(/bandaging, 2\.5 s to go/);
    expect(text).toMatch(/50 bandages/);
    expect(text).toMatch(/out of your reach/);
    expect(text).toMatch(/no weapon \(a caster\)/);
  });

  it("splits a composite answer by mode", () => {
    const { mode, parts } = splitByMode({ choice: "heal:bandage", probabilities: { "heal:bandage": 0.5, "heal:potion": 0.1, "attack:swing": 0.4 } });
    expect(mode.choice).toBe("heal");
    expect(mode.probabilities.heal).toBeCloseTo(0.6);
    expect(parts.heal.probabilities.bandage).toBeCloseTo(0.5 / 0.6);
    expect(parts.attack.choice).toBe("swing");
  });
});
