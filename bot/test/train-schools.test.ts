import { describe, expect, it } from "vitest";
import { random } from "../src/bench/stats.ts";
import { sampleChivalryState, sampleNecroState, skillRows } from "../src/distill/skill.ts";
import { castDelayMs } from "../src/game/caster.ts";
import { loadTemplate } from "../src/game/templates.ts";
import {
  OracleTrainBrain,
  RuleTrainBrain,
  TRAIN_FORMATS,
  actionOf,
  describeTraining,
  levelOf,
  makeTrainBrain,
  manaPerSecond,
  trainOptions,
  trainQuestion,
} from "../src/game/train-brain.ts";
import { gainChance } from "../src/game/train-odds.ts";
import {
  CHIVALRY_PRACTICE,
  type ChivalryState,
  FORM_BODIES,
  NECRO_PRACTICE,
  type NecroState,
  castChance,
  castWindow,
  chivalryOracle,
  chivalryScore,
  chivalrySeconds,
  necroOracle,
  necroRules,
  necroScore,
} from "../src/game/train-schools.ts";
import { SPELLS, spell, spellFromWords } from "../src/uo/spells.ts";

const necro = (over: Partial<NecroState> = {}): NecroState => ({
  skill: "necromancy",
  necromancy: 50,
  spiritSpeak: 50,
  meditation: 50,
  allSkills: 150,
  int: 100,
  hits: 95,
  hitsMax: 95,
  mana: 100,
  manaMax: 100,
  form: null,
  meditating: false,
  skillReadyIn: 0,
  casts: 0,
  fizzles: 0,
  gained: 0,
  seconds: 0,
  ...over,
});

const paladin = (over: Partial<ChivalryState> = {}): ChivalryState => ({
  skill: "chivalry",
  chivalry: 50,
  focus: 50,
  meditation: 50,
  allSkills: 250,
  int: 50,
  mana: 50,
  manaMax: 50,
  tithing: 300_000,
  meditating: false,
  skillReadyIn: 0,
  casts: 0,
  fizzles: 0,
  gained: 0,
  seconds: 0,
  ...over,
});

describe("Necromancy and Chivalry spells", () => {
  it("numbers them as the cast packet does, in ModernUO's registry order", () => {
    const necroIds = SPELLS.filter((s) => s.school === "necromancy").map((s) => s.id);
    const chivalryIds = SPELLS.filter((s) => s.school === "chivalry").map((s) => s.id);
    expect(necroIds).toEqual(Array.from({ length: 17 }, (_, i) => 101 + i));
    expect(chivalryIds).toEqual(Array.from({ length: 10 }, (_, i) => 201 + i));
    expect(spell("animateDead").id).toBe(101);
    expect(spell("vampiricEmbrace").id).toBe(113);
    expect(spell("wraithForm").id).toBe(116);
    expect(spell("divineFury").id).toBe(205);
    expect(spell("sacredJourney").id).toBe(210);
    expect(new Set(SPELLS.map((s) => s.key)).size).toBe(SPELLS.length);
    expect(new Set(SPELLS.map((s) => s.words.toLowerCase())).size).toBe(SPELLS.length);
  });

  it("knows their mana, reagents, tithing and cast times (ML)", () => {
    expect(spell("wither")).toMatchObject({ name: "Wither", words: "Kal Vas An Flam", mana: 23, delayMs: 1500, recoveryMs: 1500, requiredSkill: 60, target: "none" });
    expect(spell("wither").reagents).toEqual(["noxCrystal", "graveDust", "pigIron"]);
    expect(spell("lichForm")).toMatchObject({ mana: 23, delayMs: 2000, requiredSkill: 70, target: "self" });
    expect(spell("poisonStrike").delayMs).toBe(1750);
    expect(spell("dispelEvil")).toMatchObject({ mana: 10, tithing: 10, delayMs: 250, recoveryMs: 1750, requiredSkill: 35 });
    expect(spell("nobleSacrifice")).toMatchObject({ mana: 20, tithing: 30, delayMs: 1500, requiredSkill: 65 });
    expect(spellFromWords("rel xen um")?.key).toBe("wraithForm");
  });

  it("leaves Magery's spells as they were", () => {
    for (const s of SPELLS.filter((x) => x.school === "magery")) {
      expect(castDelayMs(s)).toBe((2 + s.circle) * 250);
      expect(s.recoveryMs).toBe(1500);
    }
    expect(spell("earthquake")).toMatchObject({ id: 57, circle: 8, mana: 50 });
  });
});

describe("their odds", () => {
  it("lets a necromancer's cast gain over 40 points, a paladin's over 50", () => {
    expect(castWindow(spell("wither"), 70)).toEqual([60, 100]);
    expect(castChance(spell("horrificBeast"), 50)).toBe(0.25);
    expect(castChance(spell("divineFury"), 50)).toBe(0.5);
    expect(castChance(spell("enemyOfOne"), 50)).toBeCloseTo(0.1);
    expect(castChance(spell("holyLight"), 54.9)).toBe(0); // too difficult: never gains
  });

  it("drops Vampiric Embrace's range to 80-120 once Necromancy reaches 99", () => {
    expect(castWindow(spell("vampiricEmbrace"), 98.9)).toEqual([99, 139]);
    expect(castChance(spell("vampiricEmbrace"), 98.9)).toBe(0);
    expect(castWindow(spell("vampiricEmbrace"), 99)).toEqual([80, 120]);
    expect(castChance(spell("vampiricEmbrace"), 99)).toBeCloseTo(0.475);
  });

  it("adds Focus and a form to mana regeneration, floored as ML does", () => {
    expect(manaPerSecond(100, 50, false, 0, 13)).toBeCloseTo(2.1); // Lich Form: 6.25 + 13 points
    expect(manaPerSecond(100, 50, true, 0, 13)).toBeCloseTo(2.7);
    expect(manaPerSecond(50, 50, false, 50)).toBeCloseTo(0.9); // 2.5 + 5 points
    expect(manaPerSecond(50, 50, true, 50)).toBeCloseTo(1.4);
    expect(gainChance(150, 50, 0)).toBe(0);
    expect(gainChance(150, 50, 1)).toBe(0);
    expect(gainChance(150, 50, 0.5)).toBeCloseTo(((550 / 700 + 0.5) / 2) / 2 + 0.0625);
  });
});

describe("a necromancer's options", () => {
  it("offers the forms and spells it can cast, and tells what a success does", () => {
    const options = trainOptions(necro());
    expect(Object.keys(options)).toEqual(["cast:wraithForm", "cast:horrificBeast"]); // full mana: no meditation
    expect(options["cast:horrificBeast"]).toBe("Cast Horrific Beast (11 mana, 2 s): about 25% to succeed; a success takes the form");
    const inForm = trainOptions(necro({ necromancy: 65, form: "horrificBeast", mana: 60 }));
    expect(inForm["cast:horrificBeast"]).toMatch(/; a success ends the form$/);
    expect(inForm).not.toHaveProperty("cast:wither"); // Horrific Beast: only the forms
    expect(trainOptions(necro({ necromancy: 65, mana: 60 }))["cast:wither"]).toBe("Cast Wither (23 mana, 1.5 s): about 13% to succeed");
    expect(trainOptions(necro({ necromancy: 75, form: "wraithForm" }))["cast:lichForm"]).toMatch(/takes the form instead of Wraith Form$/);
  });

  it("near the end of the hits in Lich Form offers only a way out or a rest", () => {
    expect(trainOptions(necro({ necromancy: 75, form: "lichForm", hits: 30, mana: 50 }))).toHaveProperty("cast:wither");
    const options = trainOptions(necro({ necromancy: 75, form: "lichForm", hits: 20, mana: 50 }));
    expect(Object.keys(options)).toEqual(["cast:wraithForm", "cast:horrificBeast", "cast:lichForm", "meditate"]);
  });

  it("describes the form and what it does to mana", () => {
    const text = describeTraining(necro({ necromancy: 75, form: "lichForm", mana: 40 }));
    expect(text).toContain("You are in Lich Form.");
    expect(text).toContain("Mana comes back 2.1 a second, 2.7 in a trance");
    expect(text).toContain("a fizzle uses reagents but no mana");
    expect(trainQuestion(necro())).toBe("Which move raises your Necromancy the fastest from here?");
    expect(levelOf(necro({ necromancy: 61.3 }))).toBe(61.3);
  });
});

describe("the necromancer's trainers", () => {
  it("scripts the spell nearest even odds, and leaves Lich Form before the hits run low", async () => {
    const rules = new RuleTrainBrain();
    expect((await rules.decide(necro({ necromancy: 52 }))).key).toBe("cast:horrificBeast");
    expect((await rules.decide(necro({ necromancy: 80 }))).key).toBe("cast:wither");
    expect((await rules.decide(necro({ mana: 50 }))).key).toBe("meditate"); // an even chance of a trance
    expect(necroRules(necro({ necromancy: 80, form: "lichForm", hits: 40 }))).toBe("cast:lichForm");
  });

  it("works out the most gains a second: Horrific Beast, then Wither, then Lich Form", async () => {
    const oracle = new OracleTrainBrain();
    expect((await oracle.decide(necro())).key).toBe("cast:horrificBeast"); // fizzles gain too and cost no mana
    expect((await oracle.decide(necro({ necromancy: 65 }))).key).toBe("cast:wither");
    expect((await oracle.decide(necro({ necromancy: 75 }))).key).toBe("cast:lichForm");
    // In Lich Form, Wither keeps its faster mana: worth more than leaving it.
    expect(necroScore(necro({ necromancy: 72, form: "lichForm" }), "wither")).toBeGreaterThan(necroScore(necro({ necromancy: 72 }), "wither"));
    expect(necroOracle(necro({ necromancy: 72, form: "lichForm" }))).toBe("cast:wither");
    expect(necroScore(necro({ necromancy: 65, form: "horrificBeast" }), "wither")).toBe(0);
    expect(necroOracle(necro({ necromancy: 75, form: "lichForm", hits: 40 }))).toBe("cast:lichForm");
  });

  it("rests while its spell drains mana faster than it comes back", () => {
    expect(necroOracle(necro({ necromancy: 65, mana: 10 }))).toBe("meditate"); // Wither needs 23
    expect(necroOracle(necro({ necromancy: 65, mana: 50 }))).toBe("meditate"); // it drains: a trance at even odds
    expect(necroOracle(necro({ necromancy: 65, mana: 70 }))).toBe("cast:wither"); // a trance is likely later too
    expect(necroOracle(necro({ mana: 50 }))).toBe("cast:horrificBeast"); // at 25% it costs less than comes back
  });
});

describe("a paladin's options and trainers", () => {
  it("offers what mana and tithing allow, and tells what each costs", () => {
    const options = trainOptions(paladin());
    expect(Object.keys(options)).toEqual(["cast:divineFury", "cast:dispelEvil", "cast:enemyOfOne"]);
    expect(options["cast:enemyOfOne"]).toBe("Cast Enemy of One (20 mana, 10 tithing points, 0.5 s): about 10% to succeed");
    expect(Object.keys(trainOptions(paladin({ mana: 12 })))).toEqual(["cast:dispelEvil", "meditate"]);
    expect(trainOptions(paladin({ chivalry: 70, tithing: 20 }))).not.toHaveProperty("cast:nobleSacrifice");
    const text = describeTraining(paladin({ tithing: 1234 }));
    expect(text).toContain("1234 tithing points");
    expect(text).toContain("after a fizzle the next cast can start at once");
  });

  it("counts a fizzle's time without recovery", () => {
    expect(chivalrySeconds(spell("holyLight"), 0)).toBeCloseTo(1.8);
    expect(chivalrySeconds(spell("holyLight"), 1)).toBeCloseTo(3.5);
  });

  it("scripts even odds and works out the quickest gains: the hard spells that mostly fizzle", async () => {
    expect((await new RuleTrainBrain().decide(paladin())).key).toBe("cast:divineFury");
    const oracle = new OracleTrainBrain();
    expect((await oracle.decide(paladin())).key).toBe("cast:enemyOfOne");
    expect((await oracle.decide(paladin({ chivalry: 58 }))).key).toBe("cast:holyLight");
    expect((await oracle.decide(paladin({ chivalry: 68 }))).key).toBe("cast:nobleSacrifice");
    expect(chivalryScore(paladin({ chivalry: 58 }), "holyLight")).toBeGreaterThan(chivalryScore(paladin({ chivalry: 58 }), "dispelEvil"));
    expect(chivalryOracle(paladin({ mana: 15 }))).toBe("meditate"); // Enemy of One needs 20
  });
});

describe("training any school", () => {
  it("names a school's spells in its keys and its own format", () => {
    expect(actionOf("cast:wither")).toEqual({ kind: "spell", spell: "wither" });
    expect(actionOf("cast:4")).toEqual({ kind: "cast", circle: 4 });
    expect(TRAIN_FORMATS).toEqual({ magery: "skill-3", necromancy: "necromancy-1", chivalry: "chivalry-1" });
    expect(Object.keys(FORM_BODIES).map(Number)).toEqual([744, 745, 746, 747, 748, 749]);
  });

  it("reads which skill a template trains", () => {
    expect(loadTemplate("mage-trainee").train).toBeUndefined();
    expect(loadTemplate("necro-trainee").train).toBe("necromancy");
    expect(loadTemplate("paladin-trainee").train).toBe("chivalry");
  });

  it("only ever picks an option it was offered, whoever decides", async () => {
    const next = random(11);
    const brains = [new RuleTrainBrain(), new OracleTrainBrain(), makeTrainBrain("random")];
    for (let i = 0; i < 300; i++) {
      for (const s of [sampleNecroState(next), sampleChivalryState(next)]) {
        const keys = Object.keys(trainOptions(s));
        expect(keys.length).toBeGreaterThan(0);
        for (const brain of brains) {
          expect(keys).toContain((await brain.decide(s)).key);
        }
      }
    }
  });

  it("labels sampled states with the oracle, in the school's format", async () => {
    const rows = await skillRows(20, 5, "chivalry");
    expect(rows[0].id).toBe("skill-chivalry:5:0");
    expect(rows[0].format).toEqual({ describe: "chivalry-1", question: "chivalry-1" });
    expect(rows[0].questions.move.instructions).toBe("Which move raises your Chivalry the fastest from here?");
    for (const r of await skillRows(20, 5, "necromancy")) {
      expect(Object.keys(r.questions.move.criteria)).toContain(Object.entries(r.teacher.probabilities).sort((a, b) => b[1] - a[1])[0][0]);
    }
  });
});

// Practice spells: kept short of a target, so that a trainee casts them alone.
describe("practice spells", () => {
  it("need no target but the caster", () => {
    for (const key of [...NECRO_PRACTICE, ...CHIVALRY_PRACTICE]) {
      expect(["self", "none"]).toContain(spell(key).target);
    }
  });
});
