import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { journalText } from "../src/rehber/director.ts";
import {
  type Place,
  SAY_MAX,
  addCommand,
  bestiaryTypes,
  commandProblems,
  fillPlaceholders,
  goCommands,
  isArenaCommand,
  loadAll,
  moongateFirstFacet,
  moongateSwitch,
  nearArena,
  parseCategory,
  parseStep,
  sayPause,
} from "../src/rehber/scenes.ts";
import { FACETS_ML, KEYWORDS, gumpResponse, keywordSpeech, playCharacter, vendorBuy } from "../src/uo/outgoing.ts";
import { PacketWriter } from "../src/uo/io.ts";
import { World } from "../src/world/world.ts";

const PLACES: Record<string, Place> = {
  meydan: { x: 3512, y: 2570, map: "Trammel" },
  arena: { x: 1171, y: 3610, z: 0, map: "Felucca" },
};
const CREATURES = new Set(["Rat", "TimberWolf", "Mongbat", "Lich"]);
const ctx = (needsNoSession = false, aliases: string[] = []) => ({
  scene: "test",
  needsNoSession,
  places: PLACES,
  creatures: CREATURES,
  aliases: new Set(aliases),
});

describe("the scene files", () => {
  it("all validate: every line, command, place and creature", () => {
    const { categories, problems } = loadAll();
    expect(problems).toEqual([]);
    expect(categories.map((c) => c.id).sort()).toEqual(["gm", "oyuncu", "proje"]);
    for (const c of categories) {
      expect(c.scenes.length).toBeGreaterThanOrEqual(3);
      expect(c.scenes.length).toBeLessThanOrEqual(5);
    }
  });

  it("keep every arena command and arena place in scenes that wait for no session", () => {
    const { categories } = loadAll();
    for (const scene of categories.flatMap((c) => c.scenes)) {
      const atArena = scene.steps.some((s) => (s.kind === "gm" && isArenaCommand(s.command)) || (s.kind === "go" && s.place.startsWith("arena")));
      if (atArena || scene.start.startsWith("arena")) {
        expect(scene.needs, scene.id).toBe("no-session");
      }
    }
  });

  it("reject a scene that goes to the arena without waiting for no session", () => {
    const raw = { id: "x", title: "X", about: "x", scenes: [{ id: "a", title: "A", start: "arena", steps: [{ say: "Merhaba" }] }] };
    const { problems } = parseCategory(raw, "x", PLACES, CREATURES);
    expect(problems.join("\n")).toMatch(/starts at the arena: needs "no-session"/);
    raw.scenes[0] = { ...raw.scenes[0], needs: "no-session" } as (typeof raw.scenes)[0];
    expect(parseCategory(raw, "x", PLACES, CREATURES).problems).toEqual([]);
  });

  it("name the category after its file and its scenes uniquely", () => {
    const raw = { id: "y", title: "X", about: "x", scenes: [1, 2].map(() => ({ id: "a", title: "A", start: "meydan", steps: [{ wait: 1 }] })) };
    const { problems } = parseCategory(raw, "x", PLACES, CREATURES);
    expect(problems.join("\n")).toMatch(/id must be "x"/);
    expect(problems.join("\n")).toMatch(/used twice/);
  });
});

describe("steps", () => {
  it("parse each kind", () => {
    const c = ctx(false, ["kurt"]);
    expect(parseStep({ say: "Merhaba!" }, c)).toMatchObject({ kind: "say", text: "Merhaba!" });
    expect(parseStep({ gm: "[Where" }, c)).toEqual({ kind: "gm", command: "[Where", seconds: 3 });
    expect(parseStep({ gm: "[Props", target: "kurt" }, c)).toMatchObject({ target: { kind: "creature", as: "kurt" } });
    expect(parseStep({ gm: "[Tele", target: [5, 0] }, c)).toMatchObject({ target: { kind: "tile", dx: 5, dy: 0 } });
    expect(parseStep({ gm: "[Self Hide", target: "self" }, c)).toMatchObject({ target: { kind: "self" } });
    expect(parseStep({ go: "meydan" }, c)).toEqual({ kind: "go", place: "meydan" });
    expect(parseStep({ walk: [4, 0], run: true }, c)).toEqual({ kind: "walk", dx: 4, dy: 0, run: true });
    expect(parseStep({ wait: 2 }, c)).toEqual({ kind: "wait", seconds: 2 });
    expect(parseStep({ war: true }, c)).toEqual({ kind: "war", on: true });
    expect(parseStep({ attack: "kurt", max: 20 }, c)).toEqual({ kind: "attack", as: "kurt", seconds: 20 });
    expect(parseStep({ bandage: "self" }, c)).toEqual({ kind: "bandage", seconds: 15 });
    expect(parseStep({ speak: "bank" }, c)).toEqual({ kind: "speak", keyword: "bank" });
    expect(parseStep({ buy: "Bandage", graphic: "0x0E21", amount: 5, from: "healer" }, c)).toEqual({
      kind: "buy", item: "Bandage", graphic: 0x0e21, amount: 5, vendor: "healer",
    });
    expect(parseStep({ moongate: "Britain" }, c)).toEqual({ kind: "moongate", to: "Britain" });
    expect(parseStep({ cleanup: true }, c)).toEqual({ kind: "cleanup" });
  });

  it("confirm only a delete over a range", () => {
    const c = ctx();
    expect(parseStep({ gm: "[Range 5 Delete where Rat CantWalk = true", confirm: true }, c)).toMatchObject({ confirm: true });
    expect(parseStep({ gm: "[Range 5 Count where Rat CantWalk = true", confirm: true }, c)).toMatch(/only for a \[Range ... Delete/);
    expect(parseStep({ gm: "[Range 5 Delete where Rat CantWalk = true", confirm: "yes" }, c)).toMatch(/confirm is true/);
  });

  it("read wait beside say or gm as the pause, and alone as a step", () => {
    expect(parseStep({ say: "Bir an.", wait: 5 }, ctx())).toMatchObject({ kind: "say", seconds: 5 });
    expect(parseStep({ gm: "[Where", wait: 1 }, ctx())).toMatchObject({ kind: "gm", seconds: 1 });
    expect(parseStep({ wait: 31 }, ctx())).toMatch(/0.1 to 30 seconds/);
  });

  it("have exactly one action and no unknown keys", () => {
    expect(parseStep({ say: "a", go: "meydan" }, ctx())).toMatch(/say and go/);
    expect(parseStep({}, ctx())).toMatch(/has none/);
    expect(parseStep({ say: "a", target: "self" }, ctx())).toMatch(/unknown target/);
    expect(parseStep("say", ctx())).toMatch(/an object/);
  });

  it("keep spoken lines short and never a command", () => {
    expect(parseStep({ say: "x".repeat(SAY_MAX + 1) }, ctx())).toMatch(/at most 80/);
    expect(parseStep({ say: "[Where" }, ctx())).toMatch(/would be a GM command/);
    expect(parseStep({ say: "Komut: [Where" }, ctx())).toMatchObject({ kind: "say" });
  });

  it("pause 2 to 4.5 seconds a line, longer for longer lines", () => {
    expect(sayPause("Merhaba!")).toBe(2);
    expect(sayPause("x".repeat(50))).toBe(3);
    expect(sayPause("x".repeat(80))).toBe(4.2);
    expect(sayPause("x".repeat(200))).toBe(4.5);
  });

  it("add only creatures the bestiary knows, under a new name, beside the guide", () => {
    const c = ctx();
    expect(parseStep({ add: "Dragoon" }, c)).toMatch(/not a creature in data\/bestiary.json/);
    expect(parseStep({ add: "Rat", at: [6, 0] }, c)).toMatch(/at most 4 tiles/);
    expect(parseStep({ add: "Rat", set: { Location: "(1180, 3610, 0)" } }, c)).toMatch(/stays where the step puts it/);
    expect(parseStep({ add: "Rat", set: { CantWalk: false } }, c)).toMatch(/keeps CantWalk true/);
    expect(parseStep({ add: "Rat", as: "fare", set: { Blessed: true, FightMode: "None" } }, c)).toEqual({
      kind: "add", type: "Rat", dx: 1, dy: 0, set: { Blessed: "true", FightMode: "None" }, as: "fare",
    });
    expect(parseStep({ add: "Rat", as: "fare" }, c)).toMatch(/fare is taken/);
    expect(parseStep({ attack: "kurt" }, c)).toMatch(/no creature an earlier add step made/);
  });

  it("go only to known places, and to the arena only without a session", () => {
    expect(parseStep({ go: "britain" }, ctx())).toMatch(/not a place/);
    expect(parseStep({ go: "arena" }, ctx())).toMatch(/needs "no-session"/);
    expect(parseStep({ go: "arena" }, ctx(true))).toEqual({ kind: "go", place: "arena" });
  });
});

describe("GM commands in scenes", () => {
  const problems = (command: string, noSession = false, aliases: string[] = ["kurt"]) => commandProblems(command, ctx(noSession, aliases)).join("; ");

  it("allow the GameMaster's own tools", () => {
    for (const ok of ["[Where", "[Props", "[Tele", "[Self Hide", "[Self Unhide", "[Self Set Hits 30", "[Serial {kurt} Set Hue 1153",
      "[Serial {kurt} Set Name Pamuk", "[Serial {kurt} Delete", "[Go {kurt}", "[Range 5 Count where Rat CantWalk = true",
      "[Range 5 Set Hue 1157 where Rat CantWalk = true", "[Range 5 Delete where Rat CantWalk = true", "[Facet Count where PlayerMobile",
      "[NeoPrep Rehber", "[NeoTemplate Rehber warrior-novice"]) {
      expect(problems(ok), ok).toBe("");
    }
  });

  it("refuse [Global: a GameMaster cannot, and the guide is one", () => {
    expect(problems("[Global Count where Rat")).toMatch(/Administrator's/);
  });

  it("keep arena commands for scenes without a session", () => {
    for (const c of ["[NeoPlace Rehber west 8", "[NeoSpawn Rat 1 1", "[NeoMage", "[NeoClear 20", "[NeoArena open"]) {
      expect(isArenaCommand(c)).toBe(true);
      expect(problems(c), c).toMatch(/needs "no-session"/);
      expect(problems(c, true), c).toBe("");
    }
    expect(isArenaCommand("[NeoPrep Rehber")).toBe(false);
    expect(problems("[NeoDuel Rehber Gemma", true)).toMatch(/not among the commands/);
  });

  it("let Neo commands name the guide only", () => {
    expect(problems("[NeoPrep Gemma")).toMatch(/may name only Rehber/);
    expect(problems("[NeoTemplate Gemma mage")).toMatch(/may name only Rehber/);
    expect(problems("[NeoPlace Gemma west 2", true)).toMatch(/may name only Rehber/);
  });

  it("change or delete only the scene's own creatures", () => {
    expect(problems("[Range 5 Delete where Rat")).toMatch(/CantWalk = true/);
    expect(problems("[Range 5 Delete where PlayerMobile CantWalk = true")).toMatch(/creature type/);
    expect(problems("[Range 20 Count where Rat")).toMatch(/1 to 12 tiles/);
    expect(problems("[Facet Delete where Rat CantWalk = true")).toMatch(/may only count/);
    expect(problems("[Serial 0x00001234 Delete")).toMatch(/a creature the scene added/);
    expect(problems("[Serial {wolf} Delete")).toMatch(/no earlier add step made/);
  });

  it("move nothing and keep the guide who it is", () => {
    expect(problems("[Serial {kurt} Set Map Felucca")).toMatch(/does not set map/);
    expect(problems("[Range 5 Set Location (1180,3610,0) where Rat CantWalk = true")).toMatch(/does not set location/);
    expect(problems("[Self Set AccessLevel Player")).toMatch(/does not set accesslevel on the guide/);
    expect(problems("[Self Set Name Bob")).toMatch(/does not set name on the guide/);
    expect(problems("[Go 1180 3610")).toMatch(/places are go steps/);
    expect(problems("[Add Rat")).toMatch(/come from add steps/);
    expect(problems("[Kill")).toMatch(/not among the commands/);
    expect(problems("Where")).toMatch(/not a GM command/);
  });
});

describe("what the guide says to the server", () => {
  it("adds a creature that stays put, with the scene's properties", () => {
    expect(addCommand("Lich", { Blessed: "true", FightMode: "None" })).toBe("[Add Lich set CantWalk true Blessed true FightMode None");
    expect(addCommand("Rat", { Name: "Pamuk Fare" })).toBe('[Add Rat set CantWalk true Name "Pamuk Fare"');
  });

  it("goes to another facet first when the place is there", () => {
    expect(goCommands({ x: 3484, y: 2570, z: 20, map: "Trammel" }, 1)).toEqual(["[Go 3484 2570 20"]);
    expect(goCommands({ x: 3512, y: 2570, map: "Trammel" }, 0)).toEqual(["[Go Trammel", "[Go 3512 2570"]);
    expect(goCommands({ x: 3512, y: 2570, map: "Trammel" }, -1)).toEqual(["[Go Trammel", "[Go 3512 2570"]);
  });

  it("fills a scene's creature names with their serials", () => {
    expect(fillPlaceholders("[Serial {kurt} Set Hue 1153", new Map([["kurt", 0xabcd]]))).toBe("[Serial 0x0000ABCD Set Hue 1153");
    expect(fillPlaceholders("[Serial {ayi} Delete", new Map())).toBe("[Serial {ayi} Delete");
  });

  it("reads which facet's gates a moongate gump lists first", () => {
    const layout = (first: number, second: number) =>
      `{ page 0 }{ xmfhtmlgump 5 5 200 20 1012011 0 0 }{ page 1 }{ button 10 35 2117 2118 0 0 1 }` +
      `{ xmfhtmlgump 30 35 150 20 ${first} 0 0 }{ radio 200 35 210 211 0 1 }{ page 2 }{ xmfhtmlgump 30 60 150 20 ${second} 0 0 }`;
    expect(moongateFirstFacet(layout(1012012, 1012013))).toBe("Trammel");
    expect(moongateFirstFacet(layout(1012013, 1012012))).toBe("Felucca");
    expect(moongateFirstFacet("")).toBeNull();
  });

  it("claims the facets when asked, and none by default", () => {
    expect(new DataView(playCharacter("Rehber", 0, FACETS_ML).buffer).getUint32(37)).toBe(0x1f);
    expect(new DataView(playCharacter("Neo", 0).buffer).getUint32(37)).toBe(0);
  });

  it("picks a moongate destination from the facet's own list", () => {
    expect(moongateSwitch("Trammel", "Britain")).toBe(1);
    expect(moongateSwitch("Trammel", "New Haven")).toBe(8);
    expect(moongateSwitch("Felucca", "Buccaneer's Den")).toBe(8);
    expect(moongateSwitch("Trammel", "Buccaneer's Den")).toBeNull();
    expect(moongateSwitch("Malas", "Britain")).toBeNull();
  });

  it("knows how far the arena reaches", () => {
    expect(nearArena({ x: 1171, y: 3610, map: "Felucca" })).toBe(true);
    expect(nearArena({ x: 1171, y: 3610, map: "Trammel" })).toBe(false);
    expect(nearArena({ x: 3512, y: 2570, map: "Felucca" })).toBe(false);
  });
});

/** ModernUO's UnicodeSpeech reading of an encoded 0xAD: the keywords and the text. */
function readKeywordSpeech(p: Uint8Array): { type: number; keywords: number[]; text: string } {
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  let pos = 12;
  const type = p[3];
  let value = v.getInt16(pos);
  pos += 2;
  const count = (value & 0xfff0) >> 4;
  let hold = value & 0xf;
  const keywords: number[] = [];
  for (let i = 0; i < count; i++) {
    if ((i & 1) === 0) {
      hold = (hold << 8) | p[pos++];
      keywords.push(hold);
      hold = 0;
    } else {
      value = v.getInt16(pos);
      pos += 2;
      keywords.push((value & 0xfff0) >> 4);
      hold = value & 0xf;
    }
  }
  const end = p.indexOf(0, pos);
  return { type, keywords, text: new TextDecoder().decode(p.subarray(pos, end)) };
}

describe("packets for the guide", () => {
  it("speech with keywords reads back as ModernUO reads it", () => {
    const one = keywordSpeech("vendor buy", [KEYWORDS["vendor buy"]]);
    expect(one[0]).toBe(0xad);
    expect((one[1] << 8) | one[2]).toBe(one.length);
    expect(readKeywordSpeech(one)).toEqual({ type: 0xc0, keywords: [0x3c], text: "vendor buy" });
    const two = keywordSpeech("bank balance", [KEYWORDS.bank, KEYWORDS.balance]);
    expect(readKeywordSpeech(two)).toEqual({ type: 0xc0, keywords: [2, 1], text: "bank balance" });
    const wide = keywordSpeech("vendor sell", [0x14d, 0xabc, 0x3c]);
    expect(readKeywordSpeech(wide).keywords).toEqual([0x14d, 0xabc, 0x3c]);
  });

  it("buys items by their serial in the vendor's window", () => {
    const p = vendorBuy(0x1234, [{ serial: 0x40000001, amount: 5 }]);
    expect([...p]).toEqual([0x3b, 0, 15, 0, 0, 0x12, 0x34, 0x02, 0x1a, 0x40, 0, 0, 1, 0, 5]);
    expect([...vendorBuy(0x1234, [])].slice(7)).toEqual([0x00]);
  });

  it("answers a gump with a button and its switches", () => {
    const p = gumpResponse(0x40001234, 0x5678, 1, [8]);
    const v = new DataView(p.buffer);
    expect(p[0]).toBe(0xb1);
    expect(v.getUint16(1)).toBe(p.length);
    expect([v.getUint32(3), v.getUint32(7), v.getUint32(11), v.getUint32(15), v.getUint32(19), v.getUint32(23)]).toEqual([
      0x40001234, 0x5678, 1, 1, 8, 0,
    ]);
  });
});

describe("what the guide's world reads", () => {
  it("the facet from a map change", () => {
    const w = new World();
    w.apply(0xbf, new Uint8Array([0xbf, 0, 6, 0, 8, 1]));
    expect(w.map).toBe(1);
  });

  it("a vendor's buy window and a container opening", () => {
    const w = new World();
    const opened: number[][] = [];
    w.on("container", (serial, gump) => opened.push([serial, gump]));
    w.apply(0x24, new PacketWriter(9).u8(0x24).u32(0x1234).u16(0x30).u16(0).finish());
    const p = new PacketWriter(64).u8(0x74).u16(0).u32(0x40000099).u8(2).u32(5).u8(8).nullString("1023617").u32(12).u8(4).nullString("Bag").finish(true);
    w.apply(0x74, p);
    expect(opened).toEqual([[0x1234, 0x30]]);
    expect(w.buyList).toMatchObject({ container: 0x40000099, entries: [{ price: 5, name: "1023617" }, { price: 12, name: "Bag" }] });
  });

  it("a compressed gump: serial, type and layout", () => {
    const w = new World();
    const layout = deflateSync(Buffer.from("{ page 0 }{ xmfhtmlgump 5 5 200 20 1012011 0 0 }"));
    const p = new PacketWriter(128).u8(0xdd).u16(0).u32(0x40000777).u32(0x1d3a).u32(100).u32(100)
      .u32(layout.length + 4).u32(48).bytes(layout).u32(0).u32(0).finish(true);
    w.apply(0xdd, p);
    const g = w.gumps.get(0x40000777);
    expect(g).toMatchObject({ serial: 0x40000777, typeId: 0x1d3a });
    expect(g?.layout).toContain("1012011");
    w.apply(0xbf, new PacketWriter(13).u8(0xbf).u16(13).u16(4).u32(0x1d3a).u32(0).finish());
    expect(w.gumps.size).toBe(0);
  });
});

describe("the guide's log", () => {
  it("writes known localized messages out, arguments filled in", () => {
    expect(journalText("1,250", 1042759)).toBe("Thy current bank balance is 1,250 gold.");
    expect(journalText("", 500956)).toBe("You begin applying the bandages.");
    expect(journalText("", 123)).toBe("cliloc 123");
    expect(journalText("\tAriana\t the baker", 1050045)).toBe("Ariana  the baker");
  });
});

describe("the bestiary", () => {
  it("knows the creatures the scenes add", () => {
    const known = bestiaryTypes();
    for (const t of ["Rat", "TimberWolf", "BlackBear", "GrizzlyBear", "Lich", "Mongbat"]) {
      expect(known.has(t), t).toBe(true);
    }
  });
});
