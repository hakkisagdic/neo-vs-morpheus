import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEUTRAL } from "../src/brain/tactics.ts";
import type { Decision, DuelBrain, DuelSnapshot } from "../src/brain/types.ts";

// Navrey's files, written by the tests instead of a client.
const dir = mkdtempSync(join(tmpdir(), "navrey-fight-"));
process.env.NAVREY_STATE = join(dir, "state.json");
process.env.NAVREY_WORLD = join(dir, "world.json");
process.env.NAVREY_LOG = join(dir, "log");
process.env.NAVREY_CMD = join(dir, "cmd");
const { NavreyFight, describeResult } = await import("../src/navrey/fight.ts");

const WOLF = 0x925d;

function state(over: Record<string, unknown> = {}) {
  return {
    updatedAtMs: Date.now(),
    charID: "0x00008995",
    charName: "Gemma",
    charPosX: 100,
    charPosY: 100,
    charPosZ: 0,
    charGhost: false,
    isPoisoned: false,
    isYellowHits: false,
    warMode: true,
    hits: 70,
    maxHits: 85,
    stamina: 60,
    maxStam: 60,
    mana: 20,
    maxMana: 20,
    dex: 60,
    equipped: [
      { serial: "0x40000001", name: "Viking Sword", graphic: 0x13b9, amount: 1, layer: "OneHanded" },
      { serial: "0x40000002", name: "Tear Kite Shield", graphic: 0x1b74, amount: 1, layer: "TwoHanded" },
    ],
    backpack: [
      { serial: "0x40000003", name: "60 Clean Bandage", graphic: 0x0e21, amount: 60 },
      { serial: "0x40000004", name: "3 Greater Heal Potion", graphic: 0x0f0c, amount: 3 },
    ],
    lastAttack: { kind: "mobile", serial: "0x0000925D" },
    nav: { active: false, status: "idle" },
    ...over,
  };
}

function mobile(name: string, species: string, x: number) {
  return { serial: "0x0000925D", name, species, x, y: 100, z: 0, distance: x - 100, hits: 60, maxHits: 100, isDead: false, isHuman: false };
}

const write = (file: string, data: unknown) => writeFileSync(join(dir, file), JSON.stringify(data));

/** A brain that keeps what it was shown, attacks, and lets `after` change the world after each answer. */
function brain(after: (n: number) => void = () => {}) {
  const seen: DuelSnapshot[] = [];
  const b: DuelBrain = {
    name: "test",
    async decide(s: DuelSnapshot): Promise<Decision> {
      seen.push(s);
      after(seen.length);
      return {
        brain: "test",
        model: "test",
        latencyMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        module: "melee",
        mode: { choice: "attack", probabilities: { attack: 1 } },
        parts: {},
        plan: { kind: "attack" },
        why: "attack",
        overrides: [],
      };
    },
  };
  return { b, seen };
}

describe("a fight through Navrey's files", () => {
  it("reads the fighter's kit and ends won when a corpse lies where the target stood", async () => {
    write("state.json", state());
    write("world.json", { mobiles: [mobile("a timber wolf", "Timber Wolf", 101)], containers: [] });
    const { b, seen } = brain(() => write("world.json", { mobiles: [], containers: [{ name: "A Timber Wolf Corpse", x: 101, y: 100 }] }));
    const sent: string[] = [];
    const result = await new NavreyFight(b, NEUTRAL, WOLF, { send: async (l) => (sent.push(l), []) }).run(10);

    expect(result.outcome).toBe("won");
    expect(result.decisions).toBe(1);
    const s = seen[0];
    expect(s.us.weapon?.name).toBe("viking sword");
    expect(s.us.freeHand).toBe(false); // the shield takes the second hand: no potions
    expect(s.supplies).toMatchObject({ bandages: 60, healPotions: 3 });
    expect(s.them).toMatchObject({ healthPct: 60, distance: 1, inRange: true, weapon: "natural weapon" });
    expect(sent[0]).toBe("hp 0x0000925D"); // its health asked for first
    expect(describeResult(result)).toMatch(/^won: a timber wolf is dead after \d+ s\. Your hits: 70\/85\./);
  });

  it("gives the chase up when the target stays out of reach longer than the tactics allow", async () => {
    write("state.json", state());
    write("world.json", { mobiles: [mobile("an alligator", "Alligator", 104)], containers: [] });
    const { b } = brain();
    const tactics = { ...NEUTRAL, chase: { maxTiles: 40, giveUpSeconds: 1, teleport: false } };
    const result = await new NavreyFight(b, tactics, WOLF, { send: async () => [] }).run(10);

    expect(result.outcome).toBe("gave up");
    expect(describeResult(result)).toMatch(/^gave up: an alligator stayed out of reach/);
  });

  it("tells a caster by its kind, and ends when we die", async () => {
    write("state.json", state());
    write("world.json", { mobiles: [mobile("a lich", "Lich", 104)], containers: [] });
    const { b, seen } = brain(() => write("state.json", state({ charGhost: true, hits: 0 })));
    const result = await new NavreyFight(b, NEUTRAL, WOLF, { send: async () => [] }).run(10);

    expect(result.outcome).toBe("died");
    expect(seen[0].them.weapon).toBeNull();
    expect(seen[0].them.inRange).toBe(false);
  });
});
