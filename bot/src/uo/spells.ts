// Spells: ids are the 1-based numbers the cast packet uses (Magery 1-64, Necromancy 101-117,
// Chivalry 201-210; the server takes one off and looks the spell up in a book of its school).

export type SpellTarget = "mobile" | "location" | "self" | "none";

export type SpellSchool = "magery" | "necromancy" | "chivalry";

export type Spell = {
  id: number;
  key: string;
  name: string;
  school: SpellSchool;
  /** Magery's circle; 0 for the other schools, which have none. */
  circle: number;
  mana: number;
  /** Power words; Chivalry's mantra is shown as a localized message, not spoken. */
  words: string;
  target: SpellTarget;
  harmful: boolean;
  /** Cast delay without faster casting, ms: Magery (2 + circle) / 4 s, the others their own (ModernUO, ML). */
  delayMs: number;
  /** Cast recovery, ms: 1.5 s, Chivalry's 1.75 s. */
  recoveryMs: number;
  /** Necromancy and Chivalry: the skill from which a cast can succeed (ModernUO's RequiredSkill). */
  requiredSkill?: number;
  /** Necromancy's reagents (the bot's keys); Magery's are in brain/spellbook.ts. */
  reagents?: readonly string[];
  /** Chivalry: tithing points a cast spends, whether it succeeds or fizzles. */
  tithing?: number;
};

const MANA_BY_CIRCLE = [4, 6, 9, 11, 14, 20, 40, 50];

// [key, name, words, target, harmful]
type Row = [string, string, string, SpellTarget, boolean];

// prettier-ignore
const ROWS: Row[] = [
  // 1st circle
  ["clumsy", "Clumsy", "Uus Jux", "mobile", true],
  ["createFood", "Create Food", "In Mani Ylem", "none", false],
  ["feeblemind", "Feeblemind", "Rel Wis", "mobile", true],
  ["heal", "Heal", "In Mani", "mobile", false],
  ["magicArrow", "Magic Arrow", "In Por Ylem", "mobile", true],
  ["nightSight", "Night Sight", "In Lor", "mobile", false],
  ["reactiveArmor", "Reactive Armor", "Flam Sanct", "self", false],
  ["weaken", "Weaken", "Des Mani", "mobile", true],
  // 2nd
  ["agility", "Agility", "Ex Uus", "mobile", false],
  ["cunning", "Cunning", "Uus Wis", "mobile", false],
  ["cure", "Cure", "An Nox", "mobile", false],
  ["harm", "Harm", "An Mani", "mobile", true],
  ["magicTrap", "Magic Trap", "In Jux", "mobile", false],
  ["magicUntrap", "Magic Untrap", "An Jux", "mobile", false],
  ["protection", "Protection", "Uus Sanct", "self", false],
  ["strength", "Strength", "Uus Mani", "mobile", false],
  // 3rd
  ["bless", "Bless", "Rel Sanct", "mobile", false],
  ["fireball", "Fireball", "Vas Flam", "mobile", true],
  ["magicLock", "Magic Lock", "An Por", "mobile", false],
  ["poison", "Poison", "In Nox", "mobile", true],
  ["telekinesis", "Telekinesis", "Ort Por Ylem", "mobile", false],
  ["teleport", "Teleport", "Rel Por", "location", false],
  ["unlock", "Unlock", "Ex Por", "mobile", false],
  ["wallOfStone", "Wall of Stone", "In Sanct Ylem", "location", false],
  // 4th
  ["archCure", "Arch Cure", "Vas An Nox", "location", false],
  ["archProtection", "Arch Protection", "Vas Uus Sanct", "location", false],
  ["curse", "Curse", "Des Sanct", "mobile", true],
  ["fireField", "Fire Field", "In Flam Grav", "location", true],
  ["greaterHeal", "Greater Heal", "In Vas Mani", "mobile", false],
  ["lightning", "Lightning", "Por Ort Grav", "mobile", true],
  ["manaDrain", "Mana Drain", "Ort Rel", "mobile", true],
  ["recall", "Recall", "Kal Ort Por", "mobile", false],
  // 5th
  ["bladeSpirits", "Blade Spirits", "In Jux Hur Ylem", "location", true],
  ["dispelField", "Dispel Field", "An Grav", "mobile", false],
  ["incognito", "Incognito", "Kal In Ex", "self", false],
  ["magicReflection", "Magic Reflection", "In Jux Sanct", "self", false],
  ["mindBlast", "Mind Blast", "Por Corp Wis", "mobile", true],
  ["paralyze", "Paralyze", "An Ex Por", "mobile", true],
  ["poisonField", "Poison Field", "In Nox Grav", "location", true],
  ["summonCreature", "Summon Creature", "Kal Xen", "none", false],
  // 6th
  ["dispel", "Dispel", "An Ort", "mobile", true],
  ["energyBolt", "Energy Bolt", "Corp Por", "mobile", true],
  ["explosion", "Explosion", "Vas Ort Flam", "mobile", true],
  ["invisibility", "Invisibility", "An Lor Xen", "mobile", false],
  ["mark", "Mark", "Kal Por Ylem", "mobile", false],
  ["massCurse", "Mass Curse", "Vas Des Sanct", "location", true],
  ["paralyzeField", "Paralyze Field", "In Ex Grav", "location", true],
  ["reveal", "Reveal", "Wis Quas", "location", false],
  // 7th
  ["chainLightning", "Chain Lightning", "Vas Ort Grav", "location", true],
  ["energyField", "Energy Field", "In Sanct Grav", "location", false],
  ["flamestrike", "Flamestrike", "Kal Vas Flam", "mobile", true],
  ["gateTravel", "Gate Travel", "Vas Rel Por", "mobile", false],
  ["manaVampire", "Mana Vampire", "Ort Sanct", "mobile", true],
  ["massDispel", "Mass Dispel", "Vas An Ort", "location", true],
  ["meteorSwarm", "Meteor Swarm", "Flam Kal Des Ylem", "location", true],
  ["polymorph", "Polymorph", "Vas Ylem Rel", "none", false],
  // 8th
  ["earthquake", "Earthquake", "In Vas Por", "none", true],
  ["energyVortex", "Energy Vortex", "Vas Corp Por", "location", true],
  ["resurrection", "Resurrection", "An Corp", "mobile", false],
  ["airElemental", "Air Elemental", "Kal Vas Xen Hur", "none", false],
  ["summonDaemon", "Summon Daemon", "Kal Vas Xen Corp", "none", false],
  ["earthElemental", "Earth Elemental", "Kal Vas Xen Ylem", "none", false],
  ["fireElemental", "Fire Elemental", "Kal Vas Xen Flam", "none", false],
  ["waterElemental", "Water Elemental", "Kal Vas Xen An Flam", "none", false],
];

const MAGERY: Spell[] = ROWS.map(([key, name, words, target, harmful], i) => ({
  id: i + 1,
  key,
  name,
  school: "magery",
  circle: Math.floor(i / 8) + 1,
  mana: MANA_BY_CIRCLE[Math.floor(i / 8)],
  words,
  target,
  harmful,
  delayMs: (2 + Math.floor(i / 8) + 1) * 250,
  recoveryMs: 1500,
}));

// [key, name, words, target, harmful, cast delay s, required skill, mana, reagents], in the order
// of ModernUO's spell registry (Spells/Initializer.cs) and SpellInfo: id 101 is Animate Dead.
type NecroRow = [string, string, string, SpellTarget, boolean, number, number, number, string[]];

// The forms (Horrific Beast, Lich Form, Vampiric Embrace, Wraith Form) are cast on oneself and
// toggle: cast again, they end. Wither hits everyone around. Curse Weapon needs a weapon in hand,
// Animate Dead a corpse, Summon Familiar answers with a gump, Exorcism needs Spirit Speak 100 and a
// champion spawn; the rest are curses on another mobile.
// prettier-ignore
const NECRO_ROWS: NecroRow[] = [
  ["animateDead", "Animate Dead", "Uus Corp", "mobile", false, 1.5, 40, 23, ["graveDust", "daemonBlood"]],
  ["bloodOath", "Blood Oath", "In Jux Mani Xen", "mobile", true, 1.5, 20, 13, ["daemonBlood"]],
  ["corpseSkin", "Corpse Skin", "In Agle Corp Ylem", "mobile", true, 1.5, 20, 11, ["batWing", "graveDust"]],
  ["curseWeapon", "Curse Weapon", "An Sanct Gra Char", "self", false, 0.75, 0, 7, ["pigIron"]],
  ["evilOmen", "Evil Omen", "Pas Tym An Sanct", "mobile", true, 0.75, 20, 11, ["batWing", "noxCrystal"]],
  ["horrificBeast", "Horrific Beast", "Rel Xen Vas Bal", "self", false, 2, 40, 11, ["batWing", "daemonBlood"]],
  ["lichForm", "Lich Form", "Rel Xen Corp Ort", "self", false, 2, 70, 23, ["graveDust", "daemonBlood", "noxCrystal"]],
  ["mindRot", "Mind Rot", "Wis An Ben", "mobile", true, 1.5, 30, 17, ["batWing", "pigIron", "daemonBlood"]],
  ["painSpike", "Pain Spike", "In Sar", "mobile", true, 1, 20, 5, ["graveDust", "pigIron"]],
  ["poisonStrike", "Poison Strike", "In Vas Nox", "mobile", true, 1.75, 50, 17, ["noxCrystal"]],
  ["strangle", "Strangle", "In Bal Nox", "mobile", true, 2, 65, 29, ["daemonBlood", "noxCrystal"]],
  ["summonFamiliar", "Summon Familiar", "Kal Xen Bal", "none", false, 2, 30, 17, ["batWing", "graveDust", "daemonBlood"]],
  ["vampiricEmbrace", "Vampiric Embrace", "Rel Xen An Sanct", "self", false, 2, 99, 23, ["batWing", "noxCrystal", "pigIron"]],
  ["vengefulSpirit", "Vengeful Spirit", "Kal Xen Bal Beh", "mobile", true, 2, 80, 41, ["batWing", "graveDust", "pigIron"]],
  ["wither", "Wither", "Kal Vas An Flam", "none", true, 1.5, 60, 23, ["noxCrystal", "graveDust", "pigIron"]],
  ["wraithForm", "Wraith Form", "Rel Xen Um", "self", false, 2, 20, 17, ["noxCrystal", "pigIron"]],
  ["exorcism", "Exorcism", "Ort Corp Grav", "none", true, 2, 80, 40, ["noxCrystal", "graveDust"]],
];

const NECROMANCY: Spell[] = NECRO_ROWS.map(([key, name, words, target, harmful, delay, requiredSkill, mana, reagents], i) => ({
  id: 101 + i,
  key,
  name,
  school: "necromancy",
  circle: 0,
  mana,
  words,
  target,
  harmful,
  delayMs: delay * 1000,
  recoveryMs: 1500,
  requiredSkill,
  reagents,
}));

// [key, name, mantra, target, harmful, cast delay s, required skill, mana, tithing points]
type ChivalryRow = [string, string, string, SpellTarget, boolean, number, number, number, number];

// Divine Fury, Enemy of One, Consecrate Weapon (a weapon in hand) and the area spells (Dispel Evil,
// Holy Light, Noble Sacrifice: only others around are hit or helped) need no target; Close Wounds
// wants a wounded mobile, Cleanse by Fire a poisoned one, Sacred Journey a rune.
// prettier-ignore
const CHIVALRY_ROWS: ChivalryRow[] = [
  ["cleanseByFire", "Cleanse By Fire", "Expor Flamus", "mobile", false, 1, 5, 10, 10],
  ["closeWounds", "Close Wounds", "Obsu Vulni", "mobile", false, 1.5, 0, 10, 10],
  ["consecrateWeapon", "Consecrate Weapon", "Consecrus Arma", "self", false, 0.5, 15, 10, 10],
  ["dispelEvil", "Dispel Evil", "Dispiro Malas", "none", true, 0.25, 35, 10, 10],
  ["divineFury", "Divine Fury", "Divinum Furis", "self", false, 1, 25, 15, 10],
  ["enemyOfOne", "Enemy of One", "Forul Solum", "self", false, 0.5, 45, 20, 10],
  ["holyLight", "Holy Light", "Augus Luminos", "none", true, 1.75, 55, 10, 10],
  ["nobleSacrifice", "Noble Sacrifice", "Dium Prostra", "none", false, 1.5, 65, 20, 30],
  ["removeCurse", "Remove Curse", "Extermo Vomica", "mobile", false, 1.5, 5, 20, 10],
  ["sacredJourney", "Sacred Journey", "Sanctum Viatas", "mobile", false, 1.5, 15, 10, 15],
];

const CHIVALRY: Spell[] = CHIVALRY_ROWS.map(([key, name, words, target, harmful, delay, requiredSkill, mana, tithing], i) => ({
  id: 201 + i,
  key,
  name,
  school: "chivalry",
  circle: 0,
  mana,
  words,
  target,
  harmful,
  delayMs: delay * 1000,
  recoveryMs: 1750,
  requiredSkill,
  tithing,
}));

export const SPELLS: readonly Spell[] = [...MAGERY, ...NECROMANCY, ...CHIVALRY];

const byKey = new Map(SPELLS.map((s) => [s.key, s]));
const byWords = new Map(SPELLS.map((s) => [s.words.toLowerCase(), s]));

export function spell(key: string): Spell {
  const s = byKey.get(key);
  if (!s) {
    throw new Error(`unknown spell ${key}`);
  }
  return s;
}

/** The spell whose power words were spoken, if any. */
export const spellFromWords = (text: string): Spell | undefined => byWords.get(text.trim().toLowerCase());
