import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Caster } from "../src/game/caster.ts";
import type { Session } from "../src/game/session.ts";
import { PacketWriter } from "../src/uo/io.ts";
import { spell } from "../src/uo/spells.ts";
import { World } from "../src/world/world.ts";

/** A session over a world fed by hand, keeping what the bot sends. */
function fakeSession(): { session: Session; world: World } {
  const world = new World();
  world.playerSerial = 7;
  Object.assign(world.player, { x: 1179, y: 3610, mana: 50, manaMax: 100 });
  const client = { send: () => {} };
  return { session: { world, client } as unknown as Session, world };
}

const mana = (serial: number, current: number) => new PacketWriter().u8(0xa2).u32(serial).u16(100).u16(current).finish();
const sound = (id: number, x: number, y: number) => new PacketWriter().u8(0x54).u8(1).u16(id).u16(0).u16(x).u16(y).u16(0).finish();
/** 0xC1: a localized message, as "The spell fizzles." comes. */
const localized = (cliloc: number) =>
  new PacketWriter().u8(0xc1).u16(0).u32(7).u16(0).u8(0).u16(0x3b2).u16(3).u32(cliloc).fixedString("System", 30).u16(0).finish(true);

describe("casting without a cursor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times a necromancer's success by the mana it spends", async () => {
    const { session, world } = fakeSession();
    const caster = new Caster(session);
    const outcome = caster.cast(spell("wither"), { kind: "self" });
    await vi.advanceTimersByTimeAsync(1520); // the delay, and the server's timer a little late
    world.apply(0xa2, mana(7, 51)); // regeneration first: not the cast
    world.apply(0xa2, mana(7, 28));
    expect(await outcome).toMatchObject({ result: "cast", cursorAt: 1520 });
    expect(caster.readyAt).toBe(1520 + 1500);
  });

  it("hears a paladin's fizzle, which has no recovery, and nobody else's", async () => {
    const { session, world } = fakeSession();
    const caster = new Caster(session);
    const outcome = caster.cast(spell("enemyOfOne"), { kind: "self" });
    await vi.advanceTimersByTimeAsync(500);
    world.apply(0x54, sound(0x1d6, 1300, 3610)); // another arena's paladin
    world.apply(0x54, sound(0x1d6, 1179, 3610));
    expect(await outcome).toMatchObject({ result: "fizzled", endedAt: 500 });
    expect(caster.readyAt).toBe(500);
  });

  it("counts a necromancer's fizzle from its message, and a paladin's success from its mana", async () => {
    const { session, world } = fakeSession();
    const caster = new Caster(session);
    const fizzle = caster.cast(spell("horrificBeast"), { kind: "self" });
    await vi.advanceTimersByTimeAsync(2010);
    world.apply(0xc1, localized(502632));
    expect(await fizzle).toMatchObject({ result: "fizzled", endedAt: 2010 });
    expect(caster.readyAt).toBe(2010 + 1500);
    const success = caster.cast(spell("divineFury"), { kind: "self" });
    await vi.advanceTimersByTimeAsync(1005);
    world.apply(0xa2, mana(7, 35));
    expect(await success).toMatchObject({ result: "cast", cursorAt: 2010 + 1005 });
    expect(caster.readyAt).toBe(2010 + 1005 + 1750);
  });

  it("waits out a loaded server instead of guessing: a fizzle 2.5 s late is still the cast's", async () => {
    const { session, world } = fakeSession();
    const caster = new Caster(session);
    const outcome = caster.cast(spell("horrificBeast"), { kind: "self" });
    await vi.advanceTimersByTimeAsync(4500);
    world.apply(0xc1, localized(502632));
    expect(await outcome).toMatchObject({ result: "fizzled", endedAt: 4500 });
    expect(caster.readyAt).toBe(4500 + 1500);
    const silent = caster.cast(spell("divineFury"), { kind: "self" });
    await vi.advanceTimersByTimeAsync(1000 + 5000);
    expect(await silent).toMatchObject({ result: "timeout" });
  });

  it("keeps Magery's guess: cast once the delay passes, recovery from 300 ms before", async () => {
    const { session, world } = fakeSession();
    const caster = new Caster(session);
    const outcome = caster.cast(spell("magicReflection"), { kind: "self" });
    await vi.advanceTimersByTimeAsync(1760);
    world.apply(0xa2, mana(7, 36)); // a Magery cast's mana does not end it
    await vi.advanceTimersByTimeAsync(300);
    expect(await outcome).toMatchObject({ result: "cast", cursorAt: 1750 });
    expect(caster.readyAt).toBe(1750 + 1500);
  });
});
