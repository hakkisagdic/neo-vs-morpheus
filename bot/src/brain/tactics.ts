// Tactics: a person's settings for how a fighter plays, applied on top of the model's answer.
//
// - Bands are hard limits on moves tied to health: below a band's floor that kind of move is
//   required (when the game allows one), above its ceiling it is not offered, and in between the
//   model decides.
// - Aggression shifts the model's answer between attacking (chasing included) and moves on
//   yourself, from -1 (cautious) to +1 (aggressive).
// - Chase settings go to the executor: how far to follow, when to give up, whether to teleport.
// - Kiting goes to the executor too: the tiles to keep from a melee opponent between attacks.
// - Spells to keep up (Protection, Magic Reflection): the executor casts one whenever it is off,
//   before asking the brain.
// - Exploration: the share of a model's decisions that try another legal move at random, so that
//   learning from outcomes sees what moves the model never picks would have done.
// - Matchups (`vs`): changes for one kind of opponent (melee, ranged or caster, told apart by what
//   they wield), laid over the rest of the file.
//
// Files live in tactics/*.json at the repository root; the monitor can change a running match's
// values, and every decision records the values it was made with.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Percent of maximum health: [floor, ceiling]. */
export type Band = [number, number];

/** Kinds of opponent, by what they wield: a melee weapon, a bow or crossbow, or nothing (a caster). */
export const ARCHETYPES = ["melee", "ranged", "caster"] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/** Toggled spells a fighter can keep up (AOS rules: on until cast again). */
export const KEEP_UP_SPELLS = ["protection", "magicReflection"] as const;
export type KeepUpSpell = (typeof KEEP_UP_SPELLS)[number];

export type Tactics = {
  id: string;
  aggression: number;
  heal: Band;
  retreat: Band;
  chase: { maxTiles: number; giveUpSeconds: number; teleport: boolean };
  /** Fighters: bandages and heal potions have bands of their own. */
  bandage: Band;
  healPotion: Band;
  /** Tiles from which a fighter throws explosion potions (neutral: what the game allows, 2 to 10). */
  explosionRange: [number, number];
  /**
   * Tiles to keep from a melee opponent between attacks (0: off). An archer runs while its bow
   * reloads and stands still in time for the next shot; a mage runs while it cannot cast yet.
   */
  kite: number;
  /** Spells cast whenever they are off and can be cast, before the brain is asked (casters). */
  keepUp: KeepUpSpell[];
  /** Share of a model's decisions (0 to 1) that try a random legal move other than its choice. */
  explore: number;
  /** The same settings for one kind of opponent, already laid over these (see tacticsFor). */
  vs: Partial<Record<Archetype, Tactics>>;
};

/** No tactics at all: the bot plays exactly as it does without a file. */
export const NEUTRAL: Tactics = {
  id: "neutral",
  aggression: 0,
  heal: [0, 100],
  retreat: [0, 100],
  chase: { maxTiles: 40, giveUpSeconds: 60, teleport: true },
  bandage: [0, 100],
  healPotion: [0, 100],
  explosionRange: [2, 10],
  kite: 0,
  keepUp: [],
  explore: 0,
  vs: {},
};

const TACTICS_DIR = join(import.meta.dirname, "..", "..", "..", "tactics");

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const band = (b: unknown, fallback: Band): Band =>
  Array.isArray(b) && b.length === 2 && b.every((x) => typeof x === "number")
    ? [clamp(Math.min(b[0], b[1]), 0, 100), clamp(Math.max(b[0], b[1]), 0, 100)]
    : fallback;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Validated tactics: unknown keys are ignored, missing ones keep the neutral value. A matchup in
 * `vs` holds only what changes for that kind of opponent; it is laid over the rest of the file.
 */
export function parseTactics(raw: Record<string, unknown>, id = String(raw.id ?? "custom")): Tactics {
  const base = parseFlat(raw, id);
  const vs: Partial<Record<Archetype, Tactics>> = {};
  if (isRecord(raw.vs)) {
    for (const kind of ARCHETYPES) {
      const over = raw.vs[kind];
      if (isRecord(over)) {
        const chase = isRecord(raw.chase) && isRecord(over.chase) ? { ...raw.chase, ...over.chase } : (over.chase ?? raw.chase);
        vs[kind] = parseFlat({ ...raw, ...over, chase }, `${id} vs ${kind}`);
      }
    }
  }
  return { ...base, vs };
}

/** The settings for an opponent of this kind: the file's matchup for it, or the file itself. */
export const tacticsFor = (t: Tactics, kind: Archetype | null): Tactics => (kind && t.vs[kind]) || t;

function parseFlat(raw: Record<string, unknown>, id: string): Tactics {
  const chase = (raw.chase ?? {}) as Record<string, unknown>;
  return {
    id,
    aggression: typeof raw.aggression === "number" ? clamp(raw.aggression, -1, 1) : NEUTRAL.aggression,
    heal: band(raw.heal, NEUTRAL.heal),
    retreat: band(raw.retreat, NEUTRAL.retreat),
    chase: {
      maxTiles: typeof chase.maxTiles === "number" ? clamp(chase.maxTiles, 0, 60) : NEUTRAL.chase.maxTiles,
      giveUpSeconds: typeof chase.giveUpSeconds === "number" ? clamp(chase.giveUpSeconds, 0, 600) : NEUTRAL.chase.giveUpSeconds,
      teleport: typeof chase.teleport === "boolean" ? chase.teleport : NEUTRAL.chase.teleport,
    },
    bandage: band(raw.bandage, NEUTRAL.bandage),
    healPotion: band(raw.healPotion, NEUTRAL.healPotion),
    explosionRange: (() => {
      const r = band(raw.explosionRange, [NEUTRAL.explosionRange[0], NEUTRAL.explosionRange[1]]);
      return [clamp(r[0], 1, 12), clamp(r[1], 1, 12)];
    })(),
    kite: typeof raw.kite === "number" ? Math.round(clamp(raw.kite, 0, 12)) : NEUTRAL.kite,
    keepUp: Array.isArray(raw.keepUp)
      ? KEEP_UP_SPELLS.filter((k) => (raw.keepUp as unknown[]).includes(k))
      : NEUTRAL.keepUp,
    explore: typeof raw.explore === "number" ? clamp(raw.explore, 0, 1) : NEUTRAL.explore,
    vs: {},
  };
}

export async function loadTactics(id: string): Promise<Tactics> {
  if (id === NEUTRAL.id) {
    return NEUTRAL;
  }
  if (!/^[\w-]+$/.test(id)) {
    throw new Error(`bad tactics name ${id}`);
  }
  const raw = JSON.parse(await readFile(join(TACTICS_DIR, `${id}.json`), "utf8")) as Record<string, unknown>;
  return parseTactics(raw, id);
}

/** Which band an option falls under, if any. */
export type BandKind = "heal" | "retreat" | "bandage" | "healPotion";

const BAND_OF: Record<string, BandKind> = {
  "defense:heal": "heal",
  "defense:greaterHeal": "heal",
  "defense:retreat": "retreat",
  "move:retreat": "retreat",
  "heal:bandage": "bandage",
  "heal:potion": "healPotion",
};

/** Cures stay available when a band makes healing mandatory: poison can matter more. */
const isCure = (key: string) => key === "defense:cure" || key.startsWith("cure:");

/**
 * The options the bands leave. Below a floor only that kind of move (and cures) remains; above a
 * ceiling that kind is gone. When the bands would leave nothing, the options stay as they were.
 */
export function applyBands(options: string[], healthPct: number, t: Tactics): { options: string[]; note?: string } {
  const required = new Set<BandKind>();
  for (const key of options) {
    const kind = BAND_OF[key];
    if (kind && healthPct < t[kind][0]) {
      required.add(kind);
    }
  }
  let kept: string[];
  let note: string | undefined;
  if (required.size > 0) {
    kept = options.filter((k) => required.has(BAND_OF[k]) || isCure(k));
    note = `health ${Math.round(healthPct)}% under the ${[...required].join(" and ")} band`;
  } else {
    kept = options.filter((k) => {
      const kind = BAND_OF[k];
      return !kind || healthPct <= t[kind][1];
    });
    const gone = options.length - kept.length;
    note = gone ? `health ${Math.round(healthPct)}% above a band: ${gone} option${gone > 1 ? "s" : ""} not offered` : undefined;
  }
  return kept.length ? { options: kept, note } : { options };
}

/** Attacks and chasing, as opposed to moves on yourself. */
export const isAttack = (key: string) =>
  key.startsWith("damage:") || key.startsWith("interrupt:") || key.startsWith("attack:") || key.startsWith("throw:");

/** How strongly aggression shifts the answer: at +1 an attack weighs e^1.1 = 3 times more, a move on yourself 3 times less. */
const AGGRESSION_SCALE = 1.1;

/** The model's distribution shifted by aggression and renormalised; unchanged at 0. */
export function applyAggression(p: Record<string, number>, aggression: number): Record<string, number> {
  if (aggression === 0) {
    return p;
  }
  const w = Math.exp(AGGRESSION_SCALE * aggression);
  const shifted = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, isAttack(k) ? v * w : v / w]));
  const total = Object.values(shifted).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(shifted).map(([k, v]) => [k, v / total]));
}

/** A model's answer with aggression applied; the choice becomes the new most probable option. */
export function shapeAnswer<A extends { choice: string; probabilities: Record<string, number> }>(a: A, aggression: number): A {
  if (aggression === 0) {
    return a;
  }
  const probabilities = applyAggression(a.probabilities, aggression);
  const choice = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0]?.[0] ?? a.choice;
  return { ...a, choice, probabilities };
}
