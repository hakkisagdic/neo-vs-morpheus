// Duel states to teach Laya with: real ones from recorded runs plus sampled ones that cover the
// situations a duel goes through (hurt, poisoned, out of mana, opponent mid-cast, far, close).
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { FORMAT, compositeQuestion, describeDuel, teleportTiles } from "../brain/duel-policy.ts";
import { MELEE_FORMAT, describeMelee, meleeQuestion } from "../brain/melee-policy.ts";
import type { DuelSnapshot, ModuleName } from "../brain/types.ts";
import { castDelayMs } from "../game/caster.ts";
import { spell } from "../uo/spells.ts";

export type TrainingState = {
  id: string;
  source: "run" | "sampled";
  /** The decision module whose question the state is asked with. */
  module: ModuleName;
  /** The description and question versions the state was written with (see FORMAT). */
  format: { describe: string; question: string };
  state: string;
  questions: ReturnType<typeof compositeQuestion>;
};

/** Small seeded PRNG (mulberry32) so a dataset can be regenerated exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}

const NAMES = ["Neo", "Morpheus", "Trinity", "Smith", "Niobe", "Tank", "Switch", "Apoc", "Oracle", "Seraph"];
const THEIR_SPELLS = [
  "explosion", "flamestrike", "lightning", "energyBolt", "mindBlast", "poison", "magicArrow", "harm",
  "curse", "paralyze", "weaken", "greaterHeal", "heal", "cure",
] as const;
const OUR_SPELLS = ["Explosion", "Lightning", "Harm", "Magic Arrow", "Poison", "Greater Heal", "Cure", "Flamestrike"];

function sampleSnapshot(r: ReturnType<typeof rng>): DuelSnapshot {
  const us = r.pick(NAMES);
  let them = r.pick(NAMES);
  while (them === us) {
    them = r.pick(NAMES);
  }
  const hitsMax = r.chance(0.8) ? 95 : r.int(55, 110);
  // Skew towards the interesting range: most decisions happen with someone hurt.
  const hits = Math.max(1, Math.round(hitsMax * (r.chance(0.3) ? r.next() * 0.45 : 0.3 + r.next() * 0.7)));
  const manaMax = r.chance(0.8) ? 100 : r.int(60, 120);
  const mana = r.chance(0.15) ? r.int(0, 12) : r.int(8, manaMax);
  const distance = r.chance(0.12) ? r.int(11, 15) : r.chance(0.2) ? r.int(1, 2) : r.int(3, 10);
  const casting = r.chance(0.45) ? r.pick(THEIR_SPELLS) : null;
  const castTotal = casting ? castDelayMs(spell(casting)) : 0;
  const castingForMs = casting ? r.int(0, Math.max(0, castTotal - 100)) : 0;
  const readyInMs = r.chance(0.7) ? 0 : r.int(100, 1500);

  const recent: string[] = [];
  const events = [
    `${them} took ${r.int(4, 30)} damage`,
    `${us} took ${r.int(4, 30)} damage`,
    `${us} cast ${r.pick(OUR_SPELLS)}`,
    `${them}'s spell fizzled`,
    `${us} failed (disturbed) ${r.pick(OUR_SPELLS)}`,
    `${them} began casting ${spell(r.pick(THEIR_SPELLS)).name}`,
  ];
  for (let i = r.int(0, 4); i > 0; i--) {
    recent.push(r.pick(events));
  }

  const reagents: Record<string, number> = {
    blackPearl: 50, bloodmoss: 50, garlic: 50, ginseng: 50, mandrakeRoot: 50, nightshade: 50, sulfurousAsh: 50, spidersSilk: 50,
  };
  if (r.chance(0.05)) {
    reagents[r.pick(Object.keys(reagents))] = r.int(0, 3);
  }

  const s: DuelSnapshot = {
    now: 0,
    us: {
      name: us, serial: 2, hits, hitsMax, mana, manaMax, stam: 35, stamMax: 35,
      poisoned: r.chance(0.3), x: 1176, y: 3610, z: 0, readyInMs,
      lastSpell: readyInMs > 0 ? r.pick(OUR_SPELLS) : null, lastSpellAgoMs: r.int(0, 3000),
    },
    them: {
      name: them, serial: 3, healthPct: r.chance(0.25) ? r.int(3, 30) : r.int(20, 100), poisoned: r.chance(0.3),
      x: 1176 + distance, y: 3610, z: 0, dead: false, casting, castingForMs,
      landsInMs: casting ? castTotal - castingForMs : 0, distance, inLineOfSight: true, inRange: distance <= 10,
    },
    reagents,
    tiles: [],
    recent,
  };
  s.tiles = distance > 2 ? teleportTiles(s) : [];
  return s;
}

/**
 * Mage states around moving: the opponent out of sight (behind a pillar or a wall) or out of spell
 * range, with health, poison and mana spread as in sampledStates. Duels rarely go there, and the
 * movement suite shows it: the model chases when it should stop and heal.
 */
export function sampledMovementStates(n: number, seed = 20261001): TrainingState[] {
  return movementSnapshots(n, seed).map((s, i) => toTraining(`movement:${seed}:${i}`, "sampled", s));
}

/** The movement sampler's draws as snapshots (the states are rendered from these). */
export function movementSnapshots(n: number, seed = 20261001): DuelSnapshot[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const s = sampleSnapshot(r);
    const hidden = r.chance(0.5);
    const distance = hidden ? r.int(3, 12) : r.int(11, 16);
    s.them = { ...s.them, distance, x: s.us.x + distance, inLineOfSight: !hidden, inRange: distance <= 10 };
    if (r.chance(0.3)) {
      s.recent = [...s.recent, `${s.us.name} ran ${r.int(2, 5)} tiles away from ${s.them.name}`].slice(-4);
    }
    s.tiles = distance > 2 ? teleportTiles(s) : [];
    return s;
  });
}

/** Out of sight or out of spell range: where the mage has to decide whether to move. */
export const isMovementState = (s: DuelSnapshot) => !s.them.inLineOfSight || !s.them.inRange;

const toTraining = (id: string, source: TrainingState["source"], s: DuelSnapshot, module: ModuleName = "mage"): TrainingState =>
  module === "melee"
    ? { id, source, module, format: MELEE_FORMAT, state: describeMelee(s), questions: meleeQuestion(s) }
    : { id, source, module, format: FORMAT, state: describeDuel(s), questions: compositeQuestion(s) };

/**
 * Every snapshot recorded in runs/*.json by a fighter of the given module (and passing keep, if
 * given), deduplicated by rendered state. Runs from before modules existed are the mage's.
 */
export async function statesFromRuns(
  runsDir: string,
  module: ModuleName = "mage",
  keep: (s: DuelSnapshot) => boolean = () => true,
): Promise<TrainingState[]> {
  const out: TrainingState[] = [];
  const seen = new Set<string>();
  let files: string[] = [];
  try {
    files = (await readdir(runsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const file of files) {
    const run = JSON.parse(await readFile(join(runsDir, file), "utf8")) as {
      records?: { snapshot: DuelSnapshot; decision?: { module?: ModuleName } }[];
    };
    for (const [i, rec] of (run.records ?? []).entries()) {
      if ((rec.decision?.module ?? "mage") !== module || !keep(rec.snapshot)) {
        continue;
      }
      const t = toTraining(`run:${file}:${i}`, "run", rec.snapshot, module);
      if (!seen.has(t.state)) {
        seen.add(t.state);
        out.push(t);
      }
    }
  }
  return out;
}

export function sampledStates(n: number, seed = 20260927): TrainingState[] {
  return sampledSnapshots(n, seed).map((s, i) => toTraining(`sampled:${seed}:${i}`, "sampled", s));
}

/** The sampler's draws as snapshots, in the same order (labels are rebuilt from these). */
export function sampledSnapshots(n: number, seed = 20260927): DuelSnapshot[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => sampleSnapshot(r));
}

// Fighters ------------------------------------------------------------------------------------

type Build = { weapon: NonNullable<DuelSnapshot["us"]["weapon"]>; freeHand: boolean; manaMax: number; potions: boolean };

/** The templates' fighters: a katana swordsman with a free hand, and an archer whose bow takes both. */
const BUILDS: Build[] = [
  {
    weapon: { name: "katana", ranged: false, range: 1, primary: "doubleStrike", primaryMana: 25, secondary: "armorIgnore", secondaryMana: 25 },
    freeHand: true,
    manaMax: 25,
    potions: true,
  },
  {
    weapon: { name: "bow", ranged: true, range: 10, primary: "paralyzingBlow", primaryMana: 30, secondary: "mortalStrike", secondaryMana: 30 },
    freeHand: false,
    manaMax: 35,
    potions: false,
  },
];

const THEIR_WEAPONS = [null, null, "katana", "bow", "halberd"] as const;

function sampleFighter(r: ReturnType<typeof rng>): DuelSnapshot {
  const us = r.pick(NAMES);
  let them = r.pick(NAMES);
  while (them === us) {
    them = r.pick(NAMES);
  }
  const build = r.pick(BUILDS);
  const theirWeapon = r.pick(THEIR_WEAPONS);
  const hitsMax = r.chance(0.8) ? 100 : r.int(80, 110);
  const hits = Math.max(1, Math.round(hitsMax * (r.chance(0.3) ? r.next() * 0.45 : 0.3 + r.next() * 0.7)));
  const stamMax = 100;
  const stam = r.chance(0.15) ? r.int(0, 25) : r.int(40, stamMax);
  const mana = r.int(0, build.manaMax);
  const distance = r.chance(0.4) ? r.int(1, 2) : r.chance(0.85) ? r.int(3, 10) : r.int(11, 14);
  const casting = theirWeapon === null && r.chance(0.4) ? r.pick(THEIR_SPELLS) : null;
  const castTotal = casting ? castDelayMs(spell(casting)) : 0;
  const castingForMs = casting ? r.int(0, Math.max(0, castTotal - 100)) : 0;

  const events = [
    `${us} took ${r.int(4, 30)} damage`,
    `${them} took ${r.int(4, 30)} damage`,
    `${us} began bandaging`,
    ...(build.potions ? [`${us} drank a heal potion`] : []),
    ...(theirWeapon === null ? [`${them} began casting ${spell(r.pick(THEIR_SPELLS)).name}`, `${us} was poisoned by ${them}`] : []),
  ];
  const recent = Array.from({ length: r.int(0, 4) }, () => r.pick(events));

  const s: DuelSnapshot = {
    now: 0,
    us: {
      name: us, serial: 2, hits, hitsMax, mana, manaMax: build.manaMax, stam, stamMax,
      poisoned: r.chance(0.3), x: 1176, y: 3610, z: 0, readyInMs: 0, lastSpell: null, lastSpellAgoMs: 0,
      weapon: build.weapon,
      freeHand: build.freeHand,
      bandagingForMs: r.chance(0.3) ? r.int(300, 6_000) : 0,
      healPotionReadyInMs: build.potions && r.chance(0.3) ? r.int(300, 10_000) : 0,
      lastAbilityAgoMs: r.chance(0.2) ? r.int(200, 3_000) : Number.POSITIVE_INFINITY,
    },
    them: {
      name: them, serial: 3, healthPct: r.chance(0.25) ? r.int(3, 30) : r.int(20, 100), poisoned: r.chance(0.25),
      x: 1176 + distance, y: 3610, z: 0, dead: false, casting, castingForMs,
      landsInMs: casting ? castTotal - castingForMs : 0, distance, inLineOfSight: r.chance(0.9), inRange: distance <= 10,
      weapon: theirWeapon,
    },
    supplies: {
      bandages: r.chance(0.1) ? 0 : r.int(1, 100),
      healPotions: build.potions ? r.int(0, 10) : 0,
      curePotions: build.potions ? r.int(0, 10) : 0,
      refreshPotions: build.potions ? r.int(0, 10) : 0,
      explosionPotions: build.potions ? r.int(0, 10) : 0,
      arrows: build.weapon.ranged ? r.int(0, 300) : 0,
    },
    reagents: {},
    tiles: [],
    recent,
  };
  return s;
}

/** Sampled fighter states (dexer and archer builds against casters and fighters). */
export function sampledMeleeStates(n: number, seed = 20260930): TrainingState[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => toTraining(`melee:${seed}:${i}`, "sampled", sampleFighter(r), "melee"));
}
