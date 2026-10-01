import { describe, expect, it } from "vitest";
import { legalOptions } from "../src/brain/duel-policy.ts";
import { NEUTRAL, parseTactics, tacticsFor } from "../src/brain/tactics.ts";
import type { DuelSnapshot } from "../src/brain/types.ts";
import { WEAPONS, swingDelayMs } from "../src/game/items.ts";
import { Mover, kiteDirection } from "../src/game/mover.ts";
import { PacketWriter } from "../src/uo/io.ts";
import { Grid } from "../src/world/grid.ts";
import { World } from "../src/world/world.ts";

const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];

describe("kiting and matchups in tactics files", () => {
  it("reads the tiles to keep, off unless set", () => {
    expect(NEUTRAL.kite).toBe(0);
    expect(parseTactics({ kite: 6 }).kite).toBe(6);
    expect(parseTactics({ kite: 40 }).kite).toBe(12);
  });

  it("reads the share of decisions spent exploring, off unless set", () => {
    expect(NEUTRAL.explore).toBe(0);
    expect(parseTactics({ explore: 0.25 }).explore).toBe(0.25);
    expect(parseTactics({ explore: 3 }).explore).toBe(1);
  });

  it("keeps up only the toggled spells it knows", () => {
    expect(NEUTRAL.keepUp).toEqual([]);
    expect(parseTactics({ keepUp: ["protection", "explosion"] }).keepUp).toEqual(["protection"]);
    expect(tacticsFor(parseTactics({ vs: { melee: { keepUp: ["protection"] } } }), "melee").keepUp).toEqual(["protection"]);
  });

  it("lays a matchup over the rest of the file, chase settings key by key", () => {
    const t = parseTactics({ aggression: 0.3, chase: { maxTiles: 20, teleport: true }, vs: { melee: { kite: 6, chase: { maxTiles: 8 } } } }, "archer");
    const melee = tacticsFor(t, "melee");
    expect(melee).toMatchObject({ id: "archer vs melee", aggression: 0.3, kite: 6 });
    expect(melee.chase).toMatchObject({ maxTiles: 8, teleport: true });
    expect(tacticsFor(t, "caster")).toBe(t);
    expect(tacticsFor(t, null)).toBe(t);
  });
});

describe("swing timing (ML rules)", () => {
  const bow = WEAPONS[0x13b2];
  const katana = WEAPONS[0x13ff];
  it("follows BaseWeapon.GetDelay", () => {
    expect(swingDelayMs(bow, 100)).toBe(3_500);
    expect(swingDelayMs(katana, 100)).toBe(1_750);
    expect(swingDelayMs(katana, 29)).toBe(2_500);
    expect(swingDelayMs(WEAPONS[0x1401], 300)).toBe(1_250); // never faster than 5 ticks
  });

  it("hears our swings from the server", () => {
    const w = new World();
    const seen: number[][] = [];
    w.on("swing", (a, d) => seen.push([a, d]));
    w.apply(0x2f, new PacketWriter().u8(0x2f).u8(0).u32(7).u32(9).finish());
    expect(seen).toEqual([[7, 9]]);
  });
});

describe("the kiting step", () => {
  it("runs straight away on open ground", () => {
    expect(kiteDirection({ x: 5, y: 5 }, { x: 5, y: 6 })).toBe(0); // they are south: go north
    expect(kiteDirection({ x: 5, y: 5 }, { x: 4, y: 6 })).toBe(1); // south-west: go north-east
  });

  it("goes round a blocked tile, keeping them in sight", () => {
    const grid = new Grid([{ x: 5, y: 4 }]);
    const d = kiteDirection({ x: 5, y: 5 }, { x: 5, y: 6 }, grid);
    expect(d === 1 || d === 7).toBe(true);
  });

  it("gives up when no step gains distance", () => {
    const walls = [-1, 0, 1].flatMap((dx) => [{ x: 5 + dx, y: 4 }]).concat([{ x: 4, y: 5 }, { x: 6, y: 5 }]);
    expect(kiteDirection({ x: 5, y: 5 }, { x: 5, y: 6 }, new Grid(walls))).toBeNull();
  });

  it("stops when told to, after turning to face away", async () => {
    const player = { x: 5, y: 5, direction: 4 };
    const mover = new Mover({ world: { player } } as never);
    mover.step = async (direction: number) => {
      if (player.direction !== direction) {
        player.direction = direction;
      } else {
        player.x += DX[direction];
        player.y += DY[direction];
      }
      return true;
    };
    const threat = { x: 5, y: 6 };
    const steps = await mover.kite(threat, 4, undefined, () => player.y <= 3);
    expect(steps).toBe(2);
    expect(player).toEqual({ x: 5, y: 3, direction: 0 });
  });
});

const snapshot = (us: Partial<DuelSnapshot["us"]> = {}, them: Partial<DuelSnapshot["them"]> = {}): DuelSnapshot => ({
  now: 0,
  us: {
    name: "Neo", serial: 1, hits: 95, hitsMax: 100, mana: 100, manaMax: 100, stam: 50, stamMax: 50, poisoned: false,
    x: 0, y: 0, z: 0, readyInMs: 0, lastSpell: null, lastSpellAgoMs: 0, ...us,
  },
  them: {
    name: "Morpheus", serial: 2, healthPct: 80, poisoned: false, x: 5, y: 0, z: 0, dead: false, casting: null,
    castingForMs: 0, landsInMs: 0, distance: 5, inLineOfSight: true, inRange: true, ...them,
  },
  reagents: { blackPearl: 9, bloodmoss: 9, garlic: 9, ginseng: 9, mandrakeRoot: 9, nightshade: 9, sulfurousAsh: 9, spidersSilk: 9 },
  tiles: [],
  recent: [],
});

describe("Protection (AOS rules)", () => {
  it("offers no interrupt against a protected caster: our hits do not break their spells", () => {
    const casting = { casting: "explosion", landsInMs: 1_800 };
    expect(legalOptions(snapshot({}, casting))).toContain("interrupt:weaken");
    expect(legalOptions(snapshot({}, { ...casting, protection: true })).filter((k) => k.startsWith("interrupt:"))).toEqual([]);
  });

  it("dooms none of our casts while we are protected, and slows them", () => {
    // Their Lightning lands in 1 s: Explosion (2 s) would be broken, unless we are protected.
    const lightning = { casting: "lightning", landsInMs: 1_000 };
    expect(legalOptions(snapshot({}, lightning))).not.toContain("damage:explosion");
    expect(legalOptions(snapshot({}, lightning))).toContain("defense:hold");
    const protectedUs = legalOptions(snapshot({ protection: true }, lightning));
    expect(protectedUs).toContain("damage:explosion");
    expect(protectedUs).not.toContain("defense:hold");
    // Magic Arrow takes 1.25 s under Protection: too slow to interrupt a spell landing in 1 s.
    expect(protectedUs).not.toContain("interrupt:magicArrow");
  });
});
