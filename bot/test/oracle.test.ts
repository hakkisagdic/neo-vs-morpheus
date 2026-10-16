import { describe, expect, it } from "vitest";
import { costLeft, oracleAnswer } from "../src/distill/oracle.ts";
import type { DuelSnapshot } from "../src/brain/types.ts";

const options = ["attack:swing", "heal:bandage", "heal:potion", "move:retreat"];
const fight = (hits: number, loss: number, theirHealth: number, bandaging = 0): DuelSnapshot =>
  ({
    now: 0,
    us: { name: "Gemma", serial: 1, hits, hitsMax: 85, mana: 20, manaMax: 20, stam: 60, stamMax: 60, poisoned: false, x: 0, y: 0, z: 0,
      readyInMs: 0, lastSpell: null, lastSpellAgoMs: 0, bandagingForMs: bandaging },
    them: { name: "a grizzly bear", serial: 2, healthPct: theirHealth, poisoned: false, x: 1, y: 0, z: 0, dead: false, casting: null,
      castingForMs: 0, landsInMs: 0, distance: 1, inLineOfSight: true, inRange: true,
      creature: { danger: "deadly", loss, attacksOnSight: false, caster: false } },
    reagents: {}, tiles: [], recent: [],
  }) as DuelSnapshot;

describe("the danger oracle", () => {
  it("leaves a fight that would cost more than the health left", () => {
    expect(oracleAnswer(fight(85, 1.52, 100), options)?.choice).toBe("move:retreat");
    expect(oracleAnswer(fight(20, 1.52, 100), options)?.choice).toBe("heal:potion"); // too hurt to run first
  });

  it("finishes a dangerous creature that is nearly dead, and heals first when hurt", () => {
    expect(costLeft(fight(85, 1.52, 20))).toBeCloseTo(0.304);
    expect(oracleAnswer(fight(85, 1.52, 20), options)?.choice).toBe("attack:swing");
    expect(oracleAnswer(fight(40, 1.52, 40), options)?.choice).toBe("heal:bandage");
    expect(oracleAnswer(fight(40, 1.52, 40, 2_000), options)?.choice).toBe("heal:potion"); // a bandage is on already
  });

  it("has no view on a player, and its answer is soft", () => {
    const player = fight(85, 1, 100);
    player.them.creature = undefined;
    expect(oracleAnswer(player, options)).toBeNull();
    const a = oracleAnswer(fight(85, 0.2, 100), options);
    expect(a?.probabilities["attack:swing"]).toBe(0.75);
    expect(Object.values(a?.probabilities ?? {}).reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });
});
