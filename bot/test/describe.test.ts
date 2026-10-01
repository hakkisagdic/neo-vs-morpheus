import { describe, expect, it } from "vitest";
import { FORMAT, describeDuel } from "../src/brain/duel-policy.ts";
import type { DuelSnapshot } from "../src/brain/types.ts";

const snapshot = (them: Partial<DuelSnapshot["them"]> = {}): DuelSnapshot => ({
  now: 0,
  us: {
    name: "Neo", serial: 1, hits: 95, hitsMax: 100, mana: 100, manaMax: 100, stam: 50, stamMax: 50, poisoned: false,
    x: 0, y: 0, z: 0, readyInMs: 0, lastSpell: null, lastSpellAgoMs: 0,
  },
  them: {
    name: "Morpheus", serial: 2, healthPct: 80, poisoned: false, x: 5, y: 0, z: 0, dead: false, casting: null,
    castingForMs: 0, landsInMs: 0, distance: 5, inLineOfSight: true, inRange: true, ...them,
  },
  reagents: { blackPearl: 9, bloodmoss: 9, garlic: 9, ginseng: 9, mandrakeRoot: 9, nightshade: 9, sulfurousAsh: 9, spidersSilk: 9 },
  tiles: [],
  recent: [],
});

describe("the mage's state text (duel-2)", () => {
  it("says nothing new against a caster, so duel-1 labels still hold", () => {
    expect(FORMAT.describe).toBe("duel-2");
    const line = describeDuel(snapshot({ weapon: null, protection: false })).split("\n")[2];
    expect(line).toBe("Morpheus: health 80%, not poisoned, not casting, 5 tiles away, in line of sight, within spell range.");
  });

  it("names a melee weapon and what its hits do to a cast", () => {
    expect(describeDuel(snapshot({ weapon: "katana" }))).toContain(
      "wielding a katana (melee: next to you their hits break your spells unless you are under Protection), not casting",
    );
  });

  it("names a bow as ranged", () => {
    expect(describeDuel(snapshot({ weapon: "bow" }))).toContain("shooting a bow (ranged: they hit from afar and do not cast)");
  });

  it("says when their spells cannot be broken", () => {
    expect(describeDuel(snapshot({ protection: true, casting: "explosion", landsInMs: 1_500 }))).toContain(
      "under Protection (your hits cannot break their spells), casting Explosion",
    );
  });
});
