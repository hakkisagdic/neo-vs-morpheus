// Every Magery spell as data: its role in a fight, what it is aimed at, its reagents (ModernUO's
// SpellInfo), and the text a model reads for it. A profile picks from here which spells a bot is
// offered; the book, mana, reagents and the rules of the moment narrow that further. A spell is
// offered only once the bot can carry it out: READY lists those.

export type SpellRole = "damage" | "debuff" | "heal" | "cure" | "buff" | "field" | "summon" | "travel" | "utility";
export type SpellAim = "mobile" | "location" | "none" | "item";
export type SpellEntry = { circle: number; role: SpellRole; aim: SpellAim; reagents: string[]; text: string };

export const SPELLBOOK: Record<string, SpellEntry> = {
  clumsy: { circle: 1, role: "debuff", aim: "mobile", reagents: ["bloodmoss", "nightshade"], text: "lowers their Dexterity for a while" },
  createFood: { circle: 1, role: "utility", aim: "none", reagents: ["garlic", "ginseng", "mandrakeRoot"], text: "makes food" },
  feeblemind: { circle: 1, role: "debuff", aim: "mobile", reagents: ["ginseng", "nightshade"], text: "lowers their Intelligence for a while" },
  heal: { circle: 1, role: "heal", aim: "mobile", reagents: ["garlic", "ginseng", "spidersSilk"], text: "In Mani: small quick heal, 0.75 s" },
  magicArrow: { circle: 1, role: "damage", aim: "mobile", reagents: ["sulfurousAsh"], text: "In Por Ylem: fastest 0.75 s small hit, 4 mana" },
  nightSight: { circle: 1, role: "utility", aim: "mobile", reagents: ["sulfurousAsh", "spidersSilk"], text: "see in the dark" },
  reactiveArmor: { circle: 1, role: "buff", aim: "mobile", reagents: ["garlic", "spidersSilk", "sulfurousAsh"], text: "reflects some melee damage back" },
  weaken: { circle: 1, role: "debuff", aim: "mobile", reagents: ["garlic", "nightshade"], text: "Des Mani: 0.75 s, lowers their Strength and still breaks a spell" },
  agility: { circle: 2, role: "buff", aim: "mobile", reagents: ["bloodmoss", "mandrakeRoot"], text: "raises your Dexterity" },
  cunning: { circle: 2, role: "buff", aim: "mobile", reagents: ["mandrakeRoot", "nightshade"], text: "raises your Intelligence" },
  cure: { circle: 2, role: "cure", aim: "mobile", reagents: ["garlic", "ginseng"], text: "An Nox: removes poison" },
  harm: { circle: 2, role: "damage", aim: "mobile", reagents: ["nightshade", "spidersSilk"], text: "An Mani: quick 1.0 s hit that is strongest at close range" },
  magicTrap: { circle: 2, role: "utility", aim: "item", reagents: ["garlic", "spidersSilk", "sulfurousAsh"], text: "traps a container" },
  magicUntrap: { circle: 2, role: "utility", aim: "item", reagents: ["bloodmoss", "sulfurousAsh"], text: "disarms a trapped container" },
  protection: { circle: 2, role: "buff", aim: "mobile", reagents: ["garlic", "ginseng", "sulfurousAsh"], text: "Uus Sanct: your casts are broken less often by their hits, for a little physical resistance; casting it again takes it off" },
  strength: { circle: 2, role: "buff", aim: "mobile", reagents: ["mandrakeRoot", "nightshade"], text: "raises your Strength" },
  bless: { circle: 3, role: "buff", aim: "mobile", reagents: ["garlic", "mandrakeRoot"], text: "raises all your stats" },
  fireball: { circle: 3, role: "damage", aim: "mobile", reagents: ["blackPearl"], text: "Vas Flam: fire hit, 9 mana, 1.25 s" },
  magicLock: { circle: 3, role: "utility", aim: "item", reagents: ["garlic", "bloodmoss", "sulfurousAsh"], text: "locks a container" },
  poison: { circle: 3, role: "damage", aim: "mobile", reagents: ["nightshade"], text: "In Nox: poisons them for steady damage over time; pointless if they are already poisoned" },
  telekinesis: { circle: 3, role: "utility", aim: "item", reagents: ["bloodmoss", "mandrakeRoot"], text: "moves or uses an item from afar" },
  teleport: { circle: 3, role: "damage", aim: "location", reagents: ["bloodmoss", "mandrakeRoot"], text: "Rel Por: jump next to them to close the distance" },
  unlock: { circle: 3, role: "utility", aim: "item", reagents: ["bloodmoss", "sulfurousAsh"], text: "unlocks a container" },
  wallOfStone: { circle: 3, role: "field", aim: "location", reagents: ["bloodmoss", "garlic"], text: "a short stone wall that blocks walking and sight" },
  archCure: { circle: 4, role: "cure", aim: "location", reagents: ["garlic", "ginseng", "mandrakeRoot"], text: "cures poison around you" },
  archProtection: { circle: 4, role: "buff", aim: "location", reagents: ["garlic", "ginseng", "mandrakeRoot", "sulfurousAsh"], text: "Protection for you and those around you" },
  curse: { circle: 4, role: "damage", aim: "mobile", reagents: ["nightshade", "garlic", "sulfurousAsh"], text: "Des Sanct: lowers their stats and resistances before the big hits" },
  fireField: { circle: 4, role: "field", aim: "location", reagents: ["blackPearl", "spidersSilk", "sulfurousAsh"], text: "a burning field that hurts whoever stands in it" },
  greaterHeal: { circle: 4, role: "heal", aim: "mobile", reagents: ["garlic", "ginseng", "mandrakeRoot", "spidersSilk"], text: "In Vas Mani: large heal, 1.5 s, 11 mana" },
  lightning: { circle: 4, role: "damage", aim: "mobile", reagents: ["mandrakeRoot", "sulfurousAsh"], text: "Por Ort Grav: solid instant hit, 11 mana, 1.5 s to cast" },
  manaDrain: { circle: 4, role: "debuff", aim: "mobile", reagents: ["blackPearl", "mandrakeRoot", "spidersSilk"], text: "drains their mana for a while" },
  recall: { circle: 4, role: "travel", aim: "none", reagents: ["blackPearl", "bloodmoss", "mandrakeRoot"], text: "travel to a marked rune" },
  bladeSpirits: { circle: 5, role: "summon", aim: "location", reagents: ["blackPearl", "mandrakeRoot", "nightshade"], text: "whirling blades that attack whoever is nearest" },
  dispelField: { circle: 5, role: "utility", aim: "item", reagents: ["blackPearl", "spidersSilk", "sulfurousAsh", "garlic"], text: "removes a field" },
  incognito: { circle: 5, role: "utility", aim: "none", reagents: ["bloodmoss", "garlic", "nightshade"], text: "disguises your name and looks" },
  magicReflection: { circle: 5, role: "buff", aim: "none", reagents: ["garlic", "mandrakeRoot", "spidersSilk"], text: "In Jux Sanct: +10 fire, cold, poison and energy resistance for -20 physical; casting it again takes it off" },
  mindBlast: { circle: 5, role: "damage", aim: "mobile", reagents: ["blackPearl", "mandrakeRoot", "nightshade", "sulfurousAsh"], text: "Por Corp Wis: hit of (Magery + Int) / 5, lands 1 s after the cast, 14 mana, 1.75 s" },
  paralyze: { circle: 5, role: "damage", aim: "mobile", reagents: ["garlic", "mandrakeRoot", "spidersSilk"], text: "An Ex Por: freezes them so they cannot move for a few seconds" },
  poisonField: { circle: 5, role: "field", aim: "location", reagents: ["blackPearl", "nightshade", "spidersSilk"], text: "a poisonous field" },
  summonCreature: { circle: 5, role: "summon", aim: "none", reagents: ["bloodmoss", "mandrakeRoot", "spidersSilk"], text: "calls a random creature to fight for you" },
  dispel: { circle: 6, role: "debuff", aim: "mobile", reagents: ["garlic", "mandrakeRoot", "sulfurousAsh"], text: "unsummons a summoned creature" },
  energyBolt: { circle: 6, role: "damage", aim: "mobile", reagents: ["blackPearl", "nightshade"], text: "Corp Por: heavy energy hit, 20 mana, 2.0 s to cast" },
  explosion: { circle: 6, role: "damage", aim: "mobile", reagents: ["bloodmoss", "mandrakeRoot"], text: "Vas Ort Flam: heavy hit, 20 mana, 2.0 s to cast" },
  invisibility: { circle: 6, role: "travel", aim: "mobile", reagents: ["bloodmoss", "nightshade"], text: "makes you invisible until you act" },
  mark: { circle: 6, role: "utility", aim: "item", reagents: ["blackPearl", "bloodmoss", "mandrakeRoot"], text: "marks a rune for Recall and Gate" },
  massCurse: { circle: 6, role: "debuff", aim: "location", reagents: ["garlic", "nightshade", "mandrakeRoot", "sulfurousAsh"], text: "curses everyone around a spot" },
  paralyzeField: { circle: 6, role: "field", aim: "location", reagents: ["blackPearl", "ginseng", "spidersSilk"], text: "a field that freezes whoever steps in" },
  reveal: { circle: 6, role: "utility", aim: "location", reagents: ["bloodmoss", "sulfurousAsh"], text: "reveals hidden players around a spot" },
  chainLightning: { circle: 7, role: "damage", aim: "location", reagents: ["blackPearl", "bloodmoss", "mandrakeRoot", "sulfurousAsh"], text: "lightning on everyone around a spot" },
  energyField: { circle: 7, role: "field", aim: "location", reagents: ["blackPearl", "mandrakeRoot", "spidersSilk", "sulfurousAsh"], text: "an energy wall that blocks walking and sight" },
  flamestrike: { circle: 7, role: "damage", aim: "mobile", reagents: ["spidersSilk", "sulfurousAsh"], text: "Kal Vas Flam: the biggest hit, 40 mana, 2.25 s to cast" },
  gateTravel: { circle: 7, role: "travel", aim: "none", reagents: ["blackPearl", "mandrakeRoot", "sulfurousAsh"], text: "opens a gate to a marked rune" },
  manaVampire: { circle: 7, role: "debuff", aim: "mobile", reagents: ["blackPearl", "bloodmoss", "mandrakeRoot", "spidersSilk"], text: "takes their mana for yours" },
  massDispel: { circle: 7, role: "debuff", aim: "location", reagents: ["garlic", "mandrakeRoot", "blackPearl", "sulfurousAsh"], text: "unsummons creatures around a spot" },
  meteorSwarm: { circle: 7, role: "damage", aim: "location", reagents: ["bloodmoss", "mandrakeRoot", "sulfurousAsh", "spidersSilk"], text: "fire on everyone around a spot" },
  polymorph: { circle: 7, role: "utility", aim: "none", reagents: ["bloodmoss", "spidersSilk", "mandrakeRoot"], text: "changes your body" },
  earthquake: { circle: 8, role: "damage", aim: "none", reagents: ["bloodmoss", "ginseng", "mandrakeRoot", "sulfurousAsh"], text: "hits everyone around you" },
  energyVortex: { circle: 8, role: "summon", aim: "location", reagents: ["bloodmoss", "blackPearl", "mandrakeRoot", "nightshade"], text: "a vortex that attacks whoever is nearest" },
  resurrection: { circle: 8, role: "heal", aim: "mobile", reagents: ["bloodmoss", "garlic", "ginseng"], text: "brings a dead player back" },
  airElemental: { circle: 8, role: "summon", aim: "none", reagents: ["bloodmoss", "mandrakeRoot", "spidersSilk"], text: "an air elemental that fights for you" },
  summonDaemon: { circle: 8, role: "summon", aim: "none", reagents: ["bloodmoss", "mandrakeRoot", "spidersSilk", "sulfurousAsh"], text: "a daemon that fights for you" },
  earthElemental: { circle: 8, role: "summon", aim: "none", reagents: ["bloodmoss", "mandrakeRoot", "spidersSilk"], text: "an earth elemental that fights for you" },
  fireElemental: { circle: 8, role: "summon", aim: "none", reagents: ["bloodmoss", "mandrakeRoot", "spidersSilk", "sulfurousAsh"], text: "a fire elemental that fights for you" },
  waterElemental: { circle: 8, role: "summon", aim: "none", reagents: ["bloodmoss", "mandrakeRoot", "spidersSilk"], text: "a water elemental that fights for you" },
};

/**
 * Spells the executors can carry out today: aimed at the opponent or at ourselves. Fields need a
 * placement, summons their creature, travel a rune, so they wait for their executors.
 */
export const READY: ReadonlySet<string> = new Set([
  "magicArrow", "harm", "weaken", "poison", "curse", "lightning", "paralyze", "energyBolt", "mindBlast",
  "explosion", "flamestrike", "teleport", "heal", "greaterHeal", "cure", "protection", "magicReflection",
]);
