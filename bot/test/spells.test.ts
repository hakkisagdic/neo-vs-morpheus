import { describe, expect, it } from "vitest";
import { legalOptions } from "../src/brain/duel-policy.ts";
import type { DuelSnapshot } from "../src/brain/types.ts";
import { PacketWriter } from "../src/uo/io.ts";
import { World } from "../src/world/world.ts";

const snapshot = (us: Partial<DuelSnapshot["us"]> = {}, them: Partial<DuelSnapshot["them"]> = {}, reagents?: Record<string, number>): DuelSnapshot => ({
  now: 0,
  us: {
    name: "Neo", serial: 1, hits: 95, hitsMax: 100, mana: 100, manaMax: 100, stam: 50, stamMax: 50, poisoned: false,
    x: 0, y: 0, z: 0, readyInMs: 0, lastSpell: null, lastSpellAgoMs: 0, ...us,
  },
  them: {
    name: "Morpheus", serial: 2, healthPct: 80, poisoned: false, x: 5, y: 0, z: 0, dead: false, casting: null,
    castingForMs: 0, landsInMs: 0, distance: 5, inLineOfSight: true, inRange: true, ...them,
  },
  reagents: reagents ?? { blackPearl: 9, bloodmoss: 9, garlic: 9, ginseng: 9, mandrakeRoot: 9, nightshade: 9, sulfurousAsh: 9, spidersSilk: 9 },
  tiles: [],
  recent: [],
});

/** 0xDF for the player: add (1) or remove (0) a buff icon. */
const buff = (serial: number, icon: number, add: boolean) =>
  new PacketWriter().u8(0xdf).u16(0).u32(serial).u16(icon).u16(add ? 1 : 0).u32(0).u16(icon).u16(add ? 1 : 0).finish(true);

describe("buffs from the server", () => {
  it("tracks the player's buff icons and ignores other mobiles'", () => {
    const w = new World();
    w.playerSerial = 7;
    w.apply(0xdf, buff(7, 1029, true));
    w.apply(0xdf, buff(9, 1031, true));
    expect([...w.buffs]).toEqual([1029]);
    w.apply(0xdf, buff(7, 1029, false));
    expect(w.buffs.size).toBe(0);
  });
});

describe("the new spells", () => {
  it("offers Protection and Magic Reflection only while they are off", () => {
    expect(legalOptions(snapshot())).toEqual(expect.arrayContaining(["defense:protection", "defense:magicReflection", "damage:energyBolt", "damage:mindBlast"]));
    const on = legalOptions(snapshot({ protection: true, magicReflection: true }));
    expect(on).not.toContain("defense:protection");
    expect(on).not.toContain("defense:magicReflection");
  });

  it("offers only what the template's book holds", () => {
    const book = ["magicArrow", "harm", "heal", "greaterHeal", "cure"];
    const options = legalOptions(snapshot({ spells: book, hits: 60 }));
    expect(options.filter((k) => !k.startsWith("defense:retreat"))).toEqual([
      "damage:harm", "damage:magicArrow", "defense:heal", "defense:greaterHeal",
    ]);
  });

  it("offers only what the profile's list holds, from what the book allows", () => {
    // A stun profile: paralyse, arrows and heals only.
    const offer = ["paralyze", "magicArrow", "heal", "greaterHeal", "cure"];
    const options = legalOptions(snapshot({ offer, hits: 60 }));
    expect(options.filter((k) => k !== "defense:retreat")).toEqual(["damage:magicArrow", "damage:paralyze", "defense:heal", "defense:greaterHeal"]);
  });

  it("knows every Magery spell, with ModernUO's reagents", async () => {
    const { SPELLBOOK, READY } = await import("../src/brain/spellbook.ts");
    expect(Object.keys(SPELLBOOK)).toHaveLength(64);
    expect(SPELLBOOK.energyField.reagents).toEqual(["blackPearl", "mandrakeRoot", "spidersSilk", "sulfurousAsh"]);
    expect(SPELLBOOK.bladeSpirits).toMatchObject({ role: "summon", aim: "location" });
    for (const key of READY) {
      expect(SPELLBOOK[key]).toBeDefined();
    }
  });

  it("counts Mind Blast's one second before it lands", () => {
    const options = legalOptions(snapshot({}, { casting: "mindBlast", landsInMs: 500 }));
    expect(options).toContain("damage:lightning"); // 1.5 s, done as it lands at 1.5 s
    expect(options).not.toContain("damage:explosion"); // 2.0 s, broken
  });
});

describe("out of reagents", () => {
  it("lets a healthy mage with nothing left to attack with run", () => {
    const none = { blackPearl: 0, bloodmoss: 0, garlic: 9, ginseng: 9, mandrakeRoot: 0, nightshade: 0, sulfurousAsh: 0, spidersSilk: 9 };
    const options = legalOptions(snapshot({}, {}, none));
    expect(options.some((k) => k.startsWith("damage:") && k !== "damage:teleport")).toBe(false);
    expect(options).toContain("defense:retreat");
  });

  it("drops the spells whose reagent ran out and keeps the rest", () => {
    const options = legalOptions(snapshot({}, {}, { blackPearl: 9, bloodmoss: 9, garlic: 9, ginseng: 9, mandrakeRoot: 9, nightshade: 0, sulfurousAsh: 9, spidersSilk: 9 }));
    for (const k of ["damage:poison", "damage:harm", "damage:curse", "damage:energyBolt", "damage:mindBlast"]) {
      expect(options).not.toContain(k);
    }
    expect(options).toContain("damage:explosion");
    expect(options).not.toContain("defense:retreat");
  });
});
