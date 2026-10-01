// Client-to-server packets. Layouts follow ModernUO's incoming packet handlers.
import { PacketWriter } from "./io.ts";

export type ClientVersion = readonly [major: number, minor: number, revision: number, patch: number];

export function parseClientVersion(version: string): ClientVersion {
  const parts = version.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0)) {
    throw new Error(`client version must look like 7.0.102.3, got "${version}"`);
  }
  return [parts[0], parts[1], parts[2], parts[3]];
}

/** 0xEF: login seed with the client version (6.0.5+ clients). */
export const loginSeed = (seed: number, v: ClientVersion) =>
  new PacketWriter(21).u8(0xef).u32(seed).u32(v[0]).u32(v[1]).u32(v[2]).u32(v[3]).finish();

/**
 * The login packets carry the account name and password in 30-byte fields. A longer password would
 * be cut, and the server would answer "bad password" for an account it made with the whole one.
 */
const loginField = (what: string, value: string) => {
  if (value.length > 30) {
    throw new Error(`the ${what} is ${value.length} characters; UO login packets carry at most 30`);
  }
  return value;
};

/** 0x80: account login. */
export const accountLogin = (account: string, password: string) =>
  new PacketWriter(62).u8(0x80).fixedString(loginField("account name", account), 30).fixedString(loginField("password", password), 30).u8(0).finish();

/** 0xA0: pick a game server from the list. */
export const selectServer = (index: number) => new PacketWriter(3).u8(0xa0).u16(index).finish();

/** 0x91: log in to the game server with the key from the relay packet. */
export const gameLogin = (authKey: number, account: string, password: string) =>
  new PacketWriter(65).u8(0x91).u32(authKey).fixedString(loginField("account name", account), 30).fixedString(loginField("password", password), 30).finish();

/** 0xBD: answer to the server's client version request. */
export const clientVersionReply = (version: string) =>
  new PacketWriter(16).u8(0xbd).u16(0).nullString(version).finish(true);

/** 0x5D: play an existing character. */
export const playCharacter = (name: string, slot: number) =>
  new PacketWriter(73)
    .u8(0x5d)
    .u32(0xedededed)
    .fixedString(name, 30)
    .zeros(2)
    .u32(0) // client flags
    .zeros(24)
    .u32(slot)
    .u32(0x7f000001)
    .finish();

export type NewCharacter = {
  name: string;
  female: boolean;
  str: number;
  dex: number;
  int: number;
  /** Four [skill id, value] pairs; values total 100 or 120, each at most 50. */
  skills: readonly (readonly [number, number])[];
  skinHue: number;
  hairStyle: number;
  hairHue: number;
  cityIndex: number;
  slot: number;
};

/** 0xF8: create a character (7.0.16+ clients: four starting skills, 106 bytes). */
export function createCharacter(c: NewCharacter): Uint8Array {
  const w = new PacketWriter(106)
    .u8(0xf8)
    .u32(0xedededed)
    .u32(0xffffffff)
    .u8(0)
    .fixedString(c.name, 30)
    .zeros(2)
    .u32(0) // client flags
    .zeros(8)
    .u8(0) // profession: custom
    .zeros(15)
    .u8(c.female ? 3 : 2) // 7.0 clients: 2/3 = human male/female
    .u8(c.str)
    .u8(c.dex)
    .u8(c.int);
  for (let i = 0; i < 4; i++) {
    const [skill, value] = c.skills[i] ?? [0, 0];
    w.u8(skill).u8(value);
  }
  return w
    .u16(c.skinHue)
    .u16(c.hairStyle)
    .u16(c.hairHue)
    .u16(0) // no beard
    .u16(0)
    .u8(0)
    .u8(c.cityIndex)
    .u32(c.slot)
    .u32(0x7f000001)
    .u16(0) // shirt hue
    .u16(0) // pants hue
    .finish();
}

/** 0x73: keep-alive ping. */
export const ping = (seq: number) => new PacketWriter(2).u8(0x73).u8(seq).finish();

/** 0x34: request a mobile's full status (type 4) or skills (type 5). */
export const statusRequest = (serial: number, type: 4 | 5 = 4) =>
  new PacketWriter(10).u8(0x34).u32(0xedededed).u8(type).u32(serial).finish();

/** 0x02: step or turn; `seq` must follow the server's sequence (0..255, wraps to 1). */
export const moveRequest = (direction: number, seq: number, run = false) =>
  new PacketWriter(7).u8(0x02).u8(direction | (run ? 0x80 : 0)).u8(seq).u32(0).finish();

/** 0x72: war or peace mode. */
export const warMode = (on: boolean) => new PacketWriter(5).u8(0x72).bool(on).u8(0).u8(0x32).u8(0).finish();

/** 0x05: attack. */
export const attack = (serial: number) => new PacketWriter(5).u8(0x05).u32(serial).finish();

/**
 * 0xD7 0x0019: arm a weapon ability for the next swing. The index is ModernUO's
 * WeaponAbility.Abilities index (0 clears); the value travels as an encoded int (type byte 0).
 */
export const setAbility = (player: number, index: number) =>
  new PacketWriter(14).u8(0xd7).u16(0).u32(player).u16(0x19).u8(0).u32(index).finish(true);

/** 0x06: double click (use) an object. */
export const doubleClick = (serial: number) => new PacketWriter(5).u8(0x06).u32(serial).finish();

/** 0xBF/0x1C: cast a spell by its 1-based id without naming a spellbook. */
export const castSpell = (spellId: number) =>
  new PacketWriter(9).u8(0xbf).u16(9).u16(0x1c).u16(2).u16(spellId).finish();

/** 0x12/0x24: use a skill by id (e.g. 46 = Meditation). */
export const useSkill = (skillId: number) =>
  new PacketWriter(16).u8(0x12).u16(0).u8(0x24).nullString(`${skillId} 0`).finish(true);

/** 0x6C: answer a target cursor with an object. */
export const targetObject = (cursorId: number, flags: number, serial: number, x = 0, y = 0, z = 0, graphic = 0) =>
  new PacketWriter(19)
    .u8(0x6c)
    .u8(0)
    .u32(cursorId)
    .u8(flags)
    .u32(serial)
    .u16(x)
    .u16(y)
    .u8(0)
    .u8(z)
    .u16(graphic)
    .finish();

/** 0x6C: answer a target cursor with a ground location. */
export const targetLocation = (cursorId: number, flags: number, x: number, y: number, z: number, graphic = 0) =>
  new PacketWriter(19)
    .u8(0x6c)
    .u8(1)
    .u32(cursorId)
    .u8(flags)
    .u32(0)
    .u16(x)
    .u16(y)
    .u8(0)
    .u8(z)
    .u16(graphic)
    .finish();

/** 0x6C: dismiss a target cursor. */
export const cancelTarget = (cursorId: number) =>
  new PacketWriter(19).u8(0x6c).u8(0).u32(cursorId).u8(3).zeros(12).finish();

/** 0xAD: unicode speech; GM commands are just speech starting with "[". */
export const speech = (text: string, hue = 0x34, font = 3) =>
  new PacketWriter(16 + text.length * 2)
    .u8(0xad)
    .u16(0)
    .u8(0) // regular speech
    .u16(hue)
    .u16(font)
    .fixedString("ENU", 4)
    .unicodeNull(text)
    .finish(true);
