import { describe, expect, it } from "vitest";
import { PacketWriter } from "../src/uo/io.ts";
import { NECRO_REAGENTS, World } from "../src/world/world.ts";

/** 0xF3, the world item packet of 7.0 clients: 26 bytes. */
const worldItem = (serial: number, graphic: number, x: number, y: number, z: number) =>
  new PacketWriter()
    .u8(0xf3)
    .u16(0x0001)
    .u8(0) // an item, not a multi
    .u32(serial)
    .u16(graphic)
    .u8(0) // direction
    .u16(1)
    .u16(1)
    .u16(x)
    .u16(y)
    .u8(z & 0xff)
    .u8(0) // light
    .u16(0) // hue
    .u8(0) // flags
    .u16(0)
    .finish();

/** 0x11, the full status of ML (version 5), with the tithing points last. */
const status = (serial: number, mana: number, tithing: number) =>
  new PacketWriter()
    .u8(0x11)
    .u16(0)
    .u32(serial)
    .fixedString("Neo", 30)
    .u16(90)
    .u16(95) // hits, max
    .u8(0) // can be renamed
    .u8(5) // version
    .u8(0) // female
    .u16(90)
    .u16(35)
    .u16(100) // str, dex, int
    .u16(35)
    .u16(35) // stamina
    .u16(mana)
    .u16(100)
    .u32(0) // gold
    .u16(0) // armour
    .u16(80)
    .u16(400) // weight, max
    .u8(1) // race
    .u16(225) // stat cap
    .u8(0)
    .u8(5) // followers
    .zeros(14) // resistances, luck, damage
    .u32(tithing)
    .finish(true);

/** 0x25: an item put into a container (7.0 clients: with the grid index). */
const intoContainer = (serial: number, graphic: number, amount: number, container: number) =>
  new PacketWriter().u8(0x25).u32(serial).u16(graphic).u8(0).u16(amount).u16(1).u16(1).u8(0).u32(container).u16(0).finish();

describe("the player's status and pack", () => {
  it("reads Chivalry's tithing points from the full status", () => {
    const w = new World();
    w.playerSerial = 7;
    w.apply(0x11, status(7, 60, 300_000));
    expect(w.player.mana).toBe(60);
    expect(w.stats.int).toBe(100);
    expect(w.stats.tithing).toBe(300_000);
  });

  it("counts Necromancy's reagents apart from Magery's, and finds a book", () => {
    const w = new World();
    w.backpack = 0x40000010;
    w.apply(0x25, intoContainer(0x40000011, 0x0f8e, 2500, w.backpack)); // nox crystal
    w.apply(0x25, intoContainer(0x40000012, 0x0f7a, 9, w.backpack)); // black pearl
    w.apply(0x25, intoContainer(0x40000013, 0x2253, 1, w.backpack)); // a Necromancer spellbook
    expect(w.reagents(NECRO_REAGENTS)).toEqual({ batWing: 0, daemonBlood: 0, pigIron: 0, noxCrystal: 2500, graveDust: 0 });
    expect(w.reagents().blackPearl).toBe(9);
    expect(w.reagents()).not.toHaveProperty("noxCrystal");
    expect(w.carries(0x2253)).toBe(true);
    expect(w.carries(0x2252)).toBe(false);
  });

  it("reads a yellow health bar (Mortal Strike) apart from poison", () => {
    const w = new World();
    const bar = (type: number, level: number) => new PacketWriter().u8(0x17).u16(12).u32(7).u16(1).u16(type).u8(level).finish();
    w.apply(0x17, bar(2, 1));
    expect(w.mobile(7)).toMatchObject({ yellow: true, poison: 0 });
    w.apply(0x17, bar(1, 3));
    w.apply(0x17, bar(2, 0));
    expect(w.mobile(7)).toMatchObject({ yellow: false, poison: 3 });
  });

  it("hears a sound where it is played", () => {
    const w = new World();
    const heard: number[][] = [];
    w.on("sound", (id, x, y, z) => heard.push([id, x, y, z]));
    w.apply(0x54, new PacketWriter().u8(0x54).u8(1).u16(0x1d6).u16(0).u16(1179).u16(3610).u16(0).finish());
    expect(heard).toEqual([[0x1d6, 1179, 3610, 0]]);
  });
});

describe("world items", () => {
  it("keeps where ground items lie and reports the blocking ones", () => {
    const w = new World();
    w.apply(0xf3, worldItem(0x40000001, 0x0080, 1180, 3608, 0));
    w.apply(0xf3, worldItem(0x40000002, 0x0eed, 1181, 3609, -5));
    expect(w.items.get(0x40000002)).toMatchObject({ graphic: 0x0eed, x: 1181, y: 3609, z: -5 });
    expect(w.blockingTiles(new Set([0x0080]))).toEqual([{ x: 1180, y: 3608 }]);
  });
});
