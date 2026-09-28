// Decision-quality check without the clock: canonical duel moments whose right answer any
// duel mage would agree on. Each backend answers the same composite question the bot asks.
import { compositeQuestion, describeDuel, teleportTiles } from "../brain/duel-policy.ts";
import { DAMAGE_SPELLS, type DuelSnapshot } from "../brain/types.ts";

export type Scenario = {
  id: string;
  /** What a good duel mage does, as "mode:spell" options; any of them counts as right. */
  accept: string[];
  snapshot: DuelSnapshot;
};

type Us = Partial<DuelSnapshot["us"]>;
type Them = Partial<DuelSnapshot["them"]>;

function state(us: Us, them: Them, recent: string[] = []): DuelSnapshot {
  const s: DuelSnapshot = {
    now: 0,
    us: {
      name: "Neo", serial: 2, hits: 95, hitsMax: 95, mana: 100, manaMax: 100, stam: 35, stamMax: 35,
      poisoned: false, x: 1176, y: 3610, z: 0, readyInMs: 0, lastSpell: null, lastSpellAgoMs: 0, ...us,
    },
    them: {
      name: "Morpheus", serial: 3, healthPct: 100, poisoned: false, x: 1184, y: 3610, z: 0, dead: false,
      casting: null, castingForMs: 0, landsInMs: 0, distance: 8, inLineOfSight: true, inRange: true, ...them,
    },
    reagents: { blackPearl: 50, bloodmoss: 50, garlic: 50, ginseng: 50, mandrakeRoot: 50, nightshade: 50, sulfurousAsh: 50, spidersSilk: 50 },
    tiles: [],
    recent,
  };
  s.tiles = s.them.distance > 2 ? teleportTiles(s) : [];
  return s;
}

const BIG_HITS = ["damage:explosion", "damage:flamestrike", "damage:lightning"];

export const SCENARIOS: Scenario[] = [
  {
    id: "poisoned and hurt, opponent idle",
    accept: ["defense:cure"],
    snapshot: state({ hits: 45, poisoned: true }, { healthPct: 90 }, ["Neo was poisoned by Morpheus"]),
  },
  {
    id: "poisoned, full mana, opponent idle",
    accept: ["defense:cure"],
    snapshot: state({ hits: 70, poisoned: true }, { healthPct: 80 }),
  },
  {
    id: "low health, not poisoned",
    accept: ["defense:greaterHeal"],
    snapshot: state({ hits: 25 }, { healthPct: 85 }, ["Neo took 30 damage"]),
  },
  {
    id: "opponent casting Explosion, lands in 1.6 s",
    accept: ["interrupt:magicArrow", "interrupt:weaken", "interrupt:harm"],
    snapshot: state({}, { casting: "explosion", castingForMs: 400, landsInMs: 1600 }, ["Morpheus began casting Explosion"]),
  },
  {
    id: "opponent casting Flamestrike, lands in 1.9 s",
    accept: ["interrupt:magicArrow", "interrupt:weaken", "interrupt:harm"],
    snapshot: state({ hits: 80 }, { casting: "flamestrike", castingForMs: 350, landsInMs: 1900 }, ["Morpheus began casting Flamestrike"]),
  },
  {
    id: "opponent casting Greater Heal at low health",
    accept: ["interrupt:magicArrow", "interrupt:weaken", "interrupt:harm"],
    snapshot: state({}, { healthPct: 20, casting: "greaterHeal", castingForMs: 300, landsInMs: 1200 }),
  },
  {
    id: "healthy, opponent healthy and not poisoned",
    accept: ["damage:poison", ...BIG_HITS, "damage:curse"],
    snapshot: state({}, {}),
  },
  {
    id: "opponent at 12% and idle: finish them",
    accept: [...BIG_HITS, "damage:harm", "damage:magicArrow"],
    snapshot: state({ hits: 60 }, { healthPct: 12 }),
  },
  {
    id: "opponent already poisoned: hit, do not re-poison",
    accept: [...BIG_HITS, "damage:curse", "damage:harm"],
    snapshot: state({}, { healthPct: 70, poisoned: true }, ["Morpheus was poisoned"]),
  },
  {
    id: "adjacent opponent, quick hit",
    accept: ["damage:harm", ...BIG_HITS],
    snapshot: { ...state({}, { x: 1177, distance: 1, healthPct: 55 }), tiles: [] },
  },
  {
    id: "low mana: only cheap spells",
    accept: ["damage:magicArrow", "damage:harm", "damage:poison", "damage:lightning"],
    snapshot: state({ mana: 12 }, { healthPct: 60 }),
  },
  {
    id: "healthy, opponent casting a cheap Magic Arrow",
    accept: ["damage:poison", ...BIG_HITS, "damage:curse", "damage:harm"],
    snapshot: state({ hits: 90 }, { casting: "magicArrow", castingForMs: 500, landsInMs: 250 }),
  },
];

export const scenarioRequest = (s: Scenario) => ({
  state: describeDuel(s.snapshot),
  questions: compositeQuestion(s.snapshot),
});

/** Out of spell range any attack means chasing (a teleport or running closer). */
const CHASE = DAMAGE_SPELLS.map((k) => `damage:${k}`);
const far = (distance: number): Them => ({ x: 1176 + distance, distance, inRange: distance <= 10 });

/**
 * Moving: when to chase, when to stop and heal, when to run. Out of range the composite answer is
 * read as an intent: an attack chases, a defensive move is made where the bot stands.
 */
export const MOVEMENT_SCENARIOS: Scenario[] = [
  {
    id: "round start, 12 tiles apart, both fresh",
    accept: CHASE,
    snapshot: state({}, far(12)),
  },
  {
    id: "opponent nearly dead and running away",
    accept: CHASE,
    snapshot: state({ hits: 60 }, { ...far(11), healthPct: 12 }, ["Morpheus took 20 damage", "Morpheus ran 4 tiles away from Neo"]),
  },
  {
    id: "hurt and out of their reach",
    accept: ["defense:greaterHeal", "defense:heal"],
    snapshot: state({ hits: 30 }, { ...far(13), healthPct: 70 }, ["Neo took 25 damage", "Neo ran 4 tiles away from Morpheus"]),
  },
  {
    id: "poisoned and out of their reach",
    accept: ["defense:cure"],
    snapshot: state({ hits: 50, poisoned: true }, { ...far(12), healthPct: 80 }, ["Neo was poisoned by Morpheus"]),
  },
  {
    id: "nearly dead, no mana to heal, Explosion coming",
    accept: ["defense:retreat"],
    snapshot: state({ hits: 12, mana: 8 }, { casting: "explosion", castingForMs: 300, landsInMs: 1700 }, ["Neo took 30 damage", "Morpheus began casting Explosion"]),
  },
  {
    id: "healed up behind distance, opponent waiting",
    accept: CHASE,
    snapshot: state({ hits: 90, mana: 70 }, { ...far(12), healthPct: 60 }, ["Neo cast Greater Heal"]),
  },
];

export const SUITES: Record<string, Scenario[]> = { duel: SCENARIOS, movement: MOVEMENT_SCENARIOS };
