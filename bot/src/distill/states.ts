// Duel states to teach Laya with: real ones from recorded runs plus sampled ones that cover the
// situations a duel goes through (hurt, poisoned, out of mana, opponent mid-cast, far, close).
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { FORMAT, compositeQuestion, describeDuel, teleportTiles } from "../brain/duel-policy.ts";
import type { DuelSnapshot } from "../brain/types.ts";
import { castDelayMs } from "../game/caster.ts";
import { spell } from "../uo/spells.ts";

export type TrainingState = {
  id: string;
  source: "run" | "sampled";
  /** The description and question versions the state was written with (see FORMAT). */
  format: typeof FORMAT;
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

const toTraining = (id: string, source: TrainingState["source"], s: DuelSnapshot): TrainingState => ({
  id,
  source,
  format: FORMAT,
  state: describeDuel(s),
  questions: compositeQuestion(s),
});

/** Every snapshot recorded in runs/*.json, deduplicated by rendered state. */
export async function statesFromRuns(runsDir: string): Promise<TrainingState[]> {
  const out: TrainingState[] = [];
  const seen = new Set<string>();
  let files: string[] = [];
  try {
    files = (await readdir(runsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const file of files) {
    const run = JSON.parse(await readFile(join(runsDir, file), "utf8")) as { records?: { snapshot: DuelSnapshot }[] };
    for (const [i, rec] of (run.records ?? []).entries()) {
      const t = toTraining(`run:${file}:${i}`, "run", rec.snapshot);
      if (!seen.has(t.state)) {
        seen.add(t.state);
        out.push(t);
      }
    }
  }
  return out;
}

export function sampledStates(n: number, seed = 20260927): TrainingState[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => toTraining(`sampled:${seed}:${i}`, "sampled", sampleSnapshot(r)));
}
