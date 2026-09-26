// What one bot knows about the world, kept current from server packets.
// Layouts follow ModernUO's outgoing packet writers for a 7.0.x client.
import { EventEmitter } from "node:events";
import { PacketReader } from "../uo/io.ts";
import { type Spell, spellFromWords } from "../uo/spells.ts";

export type Mobile = {
  serial: number;
  name: string;
  body: number;
  x: number;
  y: number;
  z: number;
  direction: number;
  hue: number;
  flags: number;
  notoriety: number;
  /** Other mobiles' hits arrive normalised to 25. */
  hits: number;
  hitsMax: number;
  mana: number;
  manaMax: number;
  stam: number;
  stamMax: number;
  /** 0 = not poisoned, otherwise poison level + 1. */
  poison: number;
  dead: boolean;
  /** Set when the mobile speaks a spell's power words, cleared when the spell resolves. */
  casting: { spell: Spell; since: number } | null;
  lastSpell: { spell: Spell; at: number } | null;
  updatedAt: number;
};

export type Item = {
  serial: number;
  graphic: number;
  amount: number;
  container: number;
  hue: number;
};

export type JournalEntry = {
  at: number;
  serial: number;
  name: string;
  text: string;
  /** Localized message number, when the server sent one. */
  cliloc?: number;
  type: number;
};

export type TargetCursor = { id: number; type: number; flags: number; at: number };

export type Skill = { value: number; base: number; cap: number; lock: number };

type WorldEvents = {
  journal: [entry: JournalEntry];
  spellWords: [mobile: Mobile, spell: Spell];
  target: [cursor: TargetCursor];
  targetCancelled: [];
  damage: [serial: number, amount: number];
  death: [serial: number];
  moveAck: [seq: number];
  moveReject: [seq: number];
  skills: [];
};

export const LAYER_BACKPACK = 0x15;
const GHOST_BODIES = new Set([0x192, 0x193, 0x25f, 0x260, 0x2b6, 0x2b7]);

export const REAGENTS: Record<number, string> = {
  0x0f7a: "blackPearl",
  0x0f7b: "bloodmoss",
  0x0f84: "garlic",
  0x0f85: "ginseng",
  0x0f86: "mandrakeRoot",
  0x0f88: "nightshade",
  0x0f8c: "sulfurousAsh",
  0x0f8d: "spidersSilk",
};

const newMobile = (serial: number): Mobile => ({
  serial,
  name: "",
  body: 0,
  x: 0,
  y: 0,
  z: 0,
  direction: 0,
  hue: 0,
  flags: 0,
  notoriety: 0,
  hits: 0,
  hitsMax: 0,
  mana: 0,
  manaMax: 0,
  stam: 0,
  stamMax: 0,
  poison: 0,
  dead: false,
  casting: null,
  lastSpell: null,
  updatedAt: 0,
});

export class World extends EventEmitter<WorldEvents> {
  playerSerial = 0;
  mapWidth = 0;
  mapHeight = 0;
  warMode = false;
  backpack = 0;
  stats = { str: 0, dex: 0, int: 0, statCap: 0 };
  readonly mobiles = new Map<number, Mobile>();
  readonly items = new Map<number, Item>();
  readonly skills = new Map<number, Skill>();
  readonly journal: JournalEntry[] = [];
  target: TargetCursor | null = null;
  readonly now: () => number;

  constructor(now: () => number = Date.now) {
    super();
    this.now = now;
  }

  get player(): Mobile {
    return this.mobile(this.playerSerial);
  }

  mobile(serial: number): Mobile {
    let m = this.mobiles.get(serial);
    if (!m) {
      m = newMobile(serial);
      this.mobiles.set(serial, m);
    }
    return m;
  }

  /** Reagent counts in the backpack (recursively), by reagent key. */
  reagents(): Record<string, number> {
    const counts: Record<string, number> = Object.fromEntries(Object.values(REAGENTS).map((k) => [k, 0]));
    for (const item of this.items.values()) {
      const key = REAGENTS[item.graphic];
      if (key && this.#inBackpack(item)) {
        counts[key] += item.amount;
      }
    }
    return counts;
  }

  #inBackpack(item: Item): boolean {
    let container = item.container;
    for (let depth = 0; depth < 8 && container; depth++) {
      if (container === this.backpack) {
        return true;
      }
      container = this.items.get(container)?.container ?? 0;
    }
    return false;
  }

  apply(id: number, data: Uint8Array): void {
    const r = new PacketReader(data, 1);
    switch (id) {
      case 0x1b:
        return this.#loginConfirm(r);
      case 0x20:
        return this.#playerUpdate(r);
      case 0x78:
        return this.#mobileIncoming(r);
      case 0x77:
        return this.#mobileMoving(r);
      case 0x11:
        return this.#status(r);
      case 0xa1:
      case 0xa2:
      case 0xa3:
        return this.#attribute(id, r);
      case 0x17:
        return this.#healthbar(r);
      case 0x1d:
        return this.#remove(r.u32());
      case 0x2c:
        return this.#died(this.playerSerial);
      case 0xaf:
        return this.#died(r.u32());
      case 0x72:
        this.warMode = r.bool();
        return;
      case 0x22:
        this.emit("moveAck", r.u8());
        return;
      case 0x21:
        return this.#moveReject(r);
      case 0x6c:
        return this.#targetCursor(r);
      case 0x1c:
      case 0xae:
        return this.#speech(id, r);
      case 0xc1:
      case 0xcc:
        return this.#localized(id, r);
      case 0x0b: {
        const serial = r.u32();
        this.emit("damage", serial, r.u16());
        return;
      }
      case 0x3a:
        return this.#skills(r);
      case 0x3c:
        return this.#containerContent(r);
      case 0x25:
        return this.#addToContainer(r);
      case 0x2e:
        return this.#equip(r);
      case 0xf3:
        return this.#worldItem(r);
      case 0xbf:
        return this.#extended(r);
    }
  }

  #loginConfirm(r: PacketReader): void {
    this.playerSerial = r.u32();
    const m = this.player;
    r.skip(4);
    m.body = r.u16();
    m.x = r.u16();
    m.y = r.u16();
    m.z = r.i16();
    m.direction = r.u8() & 7;
    r.skip(9);
    this.mapWidth = r.u16();
    this.mapHeight = r.u16();
    m.updatedAt = this.now();
  }

  #playerUpdate(r: PacketReader): void {
    const m = this.mobile(r.u32());
    m.body = r.u16();
    r.skip(1);
    m.hue = r.u16();
    m.flags = r.u8();
    m.x = r.u16();
    m.y = r.u16();
    r.skip(2);
    m.direction = r.u8() & 7;
    m.z = r.i8();
    this.#bodyChanged(m);
  }

  #mobileIncoming(r: PacketReader): void {
    r.skip(2);
    const m = this.mobile(r.u32());
    m.body = r.u16();
    m.x = r.u16();
    m.y = r.u16();
    m.z = r.i8();
    m.direction = r.u8() & 7;
    m.hue = r.u16();
    m.flags = r.u8();
    m.notoriety = r.u8();
    // Equipment: serial, graphic, layer, hue (7.0.33.1+ always sends the hue), ends with serial 0.
    while (r.remaining >= 4) {
      const serial = r.u32();
      if (serial === 0) {
        break;
      }
      const graphic = r.u16();
      const layer = r.u8();
      const hue = r.u16();
      this.items.set(serial, { serial, graphic, amount: 1, container: m.serial, hue });
      if (layer === LAYER_BACKPACK && m.serial === this.playerSerial) {
        this.backpack = serial;
      }
    }
    this.#bodyChanged(m);
  }

  #mobileMoving(r: PacketReader): void {
    const m = this.mobile(r.u32());
    m.body = r.u16();
    m.x = r.u16();
    m.y = r.u16();
    m.z = r.i8();
    m.direction = r.u8() & 7;
    m.hue = r.u16();
    m.flags = r.u8();
    m.notoriety = r.u8();
    this.#bodyChanged(m);
  }

  #bodyChanged(m: Mobile): void {
    const wasDead = m.dead;
    m.dead = GHOST_BODIES.has(m.body);
    m.updatedAt = this.now();
    if (m.dead && !wasDead) {
      this.#died(m.serial);
    }
  }

  #status(r: PacketReader): void {
    r.skip(2);
    const m = this.mobile(r.u32());
    m.name = r.fixedString(30);
    m.hits = r.u16();
    m.hitsMax = r.u16();
    r.skip(1); // can be renamed
    const version = r.u8();
    if (version > 0 && r.remaining >= 23) {
      r.skip(1); // female
      this.stats.str = r.u16();
      this.stats.dex = r.u16();
      this.stats.int = r.u16();
      m.stam = r.u16();
      m.stamMax = r.u16();
      m.mana = r.u16();
      m.manaMax = r.u16();
      r.skip(4 + 2 + 2); // gold, armor, weight
      if (version >= 5) {
        r.skip(2 + 1); // max weight, race
      }
      this.stats.statCap = r.u16();
    }
    m.updatedAt = this.now();
  }

  #attribute(id: number, r: PacketReader): void {
    const m = this.mobile(r.u32());
    const max = r.u16();
    const current = r.u16();
    if (id === 0xa1) {
      m.hitsMax = max;
      m.hits = current;
    } else if (id === 0xa2) {
      m.manaMax = max;
      m.mana = current;
    } else {
      m.stamMax = max;
      m.stam = current;
    }
    m.updatedAt = this.now();
  }

  #healthbar(r: PacketReader): void {
    r.skip(2);
    const m = this.mobile(r.u32());
    r.skip(2);
    const type = r.u16();
    const level = r.u8();
    if (type === 1) {
      m.poison = level;
    }
    m.updatedAt = this.now();
  }

  #remove(serial: number): void {
    this.mobiles.delete(serial);
    this.items.delete(serial);
  }

  #died(serial: number): void {
    const m = this.mobile(serial);
    m.dead = true;
    m.hits = 0;
    m.casting = null;
    m.poison = 0;
    m.updatedAt = this.now();
    this.emit("death", serial);
  }

  #moveReject(r: PacketReader): void {
    const seq = r.u8();
    const m = this.player;
    m.x = r.u16();
    m.y = r.u16();
    m.direction = r.u8() & 7;
    m.z = r.i8();
    this.emit("moveReject", seq);
  }

  #targetCursor(r: PacketReader): void {
    const type = r.u8();
    const id = r.u32();
    const flags = r.u8();
    if (flags === 3) {
      this.target = null;
      this.emit("targetCancelled");
      return;
    }
    this.target = { id, type, flags, at: this.now() };
    this.emit("target", this.target);
  }

  #speech(id: number, r: PacketReader): void {
    r.skip(2);
    const serial = r.u32();
    r.skip(2); // graphic
    const type = r.u8();
    r.skip(4); // hue, font
    if (id === 0xae) {
      r.skip(4); // language
    }
    const name = r.fixedString(30);
    const text = id === 0xae ? r.unicodeNull() : r.nullString();
    this.#record({ at: this.now(), serial, name, text, type });

    const spell = type === 0x0a ? spellFromWords(text) : undefined;
    if (spell && serial) {
      const m = this.mobile(serial);
      m.casting = { spell, since: this.now() };
      m.lastSpell = { spell, at: this.now() };
      this.emit("spellWords", m, spell);
    }
  }

  #localized(id: number, r: PacketReader): void {
    r.skip(2);
    const serial = r.u32();
    r.skip(2); // graphic
    const type = r.u8();
    r.skip(4); // hue, font
    const cliloc = r.u32();
    let text = "";
    if (id === 0xcc) {
      r.skip(1); // affix type
      const name = r.fixedString(30);
      const affix = r.nullString();
      text = `${r.unicodeNull()}${affix}`;
      this.#record({ at: this.now(), serial, name, text, cliloc, type });
      return;
    }
    const name = r.fixedString(30);
    text = r.unicodeNull(true);
    this.#record({ at: this.now(), serial, name, text, cliloc, type });
  }

  #record(entry: JournalEntry): void {
    this.journal.push(entry);
    if (this.journal.length > 200) {
      this.journal.splice(0, this.journal.length - 200);
    }
    this.emit("journal", entry);
  }

  #skills(r: PacketReader): void {
    r.skip(2);
    const type = r.u8();
    const delta = type === 0xdf || type === 0xff;
    while (r.remaining >= 9) {
      const raw = r.u16();
      if (!delta && raw === 0) {
        break;
      }
      const id = delta ? raw : raw - 1; // full lists are 1-based, single updates 0-based
      const value = r.u16() / 10;
      const base = r.u16() / 10;
      const lock = r.u8();
      const cap = type === 0x02 || type === 0xdf ? r.u16() / 10 : 100;
      this.skills.set(id, { value, base, cap, lock });
      if (delta) {
        break;
      }
    }
    this.emit("skills");
  }

  #containerContent(r: PacketReader): void {
    r.skip(2);
    const count = r.u16();
    for (let i = 0; i < count && r.remaining >= 20; i++) {
      const serial = r.u32();
      const graphic = r.u16();
      r.skip(1);
      const amount = r.u16();
      r.skip(2 + 2 + 1); // x, y, grid index
      const container = r.u32();
      const hue = r.u16();
      this.items.set(serial, { serial, graphic, amount, container, hue });
    }
  }

  #addToContainer(r: PacketReader): void {
    const serial = r.u32();
    const graphic = r.u16();
    r.skip(1);
    const amount = r.u16();
    r.skip(2 + 2 + 1);
    const container = r.u32();
    const hue = r.u16();
    this.items.set(serial, { serial, graphic, amount, container, hue });
  }

  #equip(r: PacketReader): void {
    const serial = r.u32();
    const graphic = r.u16();
    r.skip(1);
    const layer = r.u8();
    const mobile = r.u32();
    const hue = r.u16();
    this.items.set(serial, { serial, graphic, amount: 1, container: mobile, hue });
    if (layer === LAYER_BACKPACK && mobile === this.playerSerial) {
      this.backpack = serial;
    }
  }

  #worldItem(r: PacketReader): void {
    r.skip(2 + 1);
    const serial = r.u32();
    const graphic = r.u16();
    r.skip(1);
    const amount = r.u16();
    r.skip(2 + 2 + 2 + 1 + 1);
    const hue = r.u16();
    this.items.set(serial, { serial, graphic, amount, container: 0, hue });
  }

  #extended(r: PacketReader): void {
    r.skip(2);
    const sub = r.u16();
    if (sub === 0x08) {
      // Map change: positions from the old facet are meaningless now.
      for (const serial of this.mobiles.keys()) {
        if (serial !== this.playerSerial) {
          this.mobiles.delete(serial);
        }
      }
    }
  }
}
