// Magery spells: ids are the 1-based numbers the cast packet uses.

export type SpellTarget = "mobile" | "location" | "self" | "none";

export type Spell = {
  id: number;
  key: string;
  name: string;
  circle: number;
  mana: number;
  words: string;
  target: SpellTarget;
  harmful: boolean;
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

export const SPELLS: readonly Spell[] = ROWS.map(([key, name, words, target, harmful], i) => ({
  id: i + 1,
  key,
  name,
  circle: Math.floor(i / 8) + 1,
  mana: MANA_BY_CIRCLE[Math.floor(i / 8)],
  words,
  target,
  harmful,
}));

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
