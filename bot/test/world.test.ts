import { describe, expect, it } from "vitest";
import { PacketWriter } from "../src/uo/io.ts";
import { World } from "../src/world/world.ts";

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

describe("world items", () => {
  it("keeps where ground items lie and reports the blocking ones", () => {
    const w = new World();
    w.apply(0xf3, worldItem(0x40000001, 0x0080, 1180, 3608, 0));
    w.apply(0xf3, worldItem(0x40000002, 0x0eed, 1181, 3609, -5));
    expect(w.items.get(0x40000002)).toMatchObject({ graphic: 0x0eed, x: 1181, y: 3609, z: -5 });
    expect(w.blockingTiles(new Set([0x0080]))).toEqual([{ x: 1180, y: 3608 }]);
  });
});
