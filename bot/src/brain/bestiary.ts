// Creatures as data: data/bestiary.json, which lab/bestiary.py reads out of ModernUO's source, and how
// a fight against one would likely go for a fighter. The same rough model as lab/bestiary.py's
// `danger`, so the strategist's `look` and Laya's question tell the same story.
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Range = [number, number];
export type Creature = {
  type: string;
  name: string;
  ai: string;
  fightMode: string;
  body?: number;
  fame?: number;
  hits?: Range;
  damage?: Range;
  skills?: Record<string, Range>;
  resist?: Record<string, Range>;
};
/** A fighter's numbers: health, its weapon skill, tactics, anatomy, parrying, its weapon's damage and swing seconds. */
export type Fighter = { hits: number; weapon: number; tactics: number; anatomy: number; parry: number; damage: number; swing: number; armor?: number };
export type DangerLevel = "low" | "medium" | "high" | "deadly";
export type Danger = { seconds: number; loss: number; level: DangerLevel };

const PATH = join(import.meta.dirname, "..", "..", "..", "data", "bestiary.json");
const mid = (r: Range | undefined, fallback = 0) => (r ? (r[0] + r[1]) / 2 : fallback);
let index: { byName: Map<string, Creature>; byBody: Map<number, Creature> } | null = null;

function load(): NonNullable<typeof index> {
  if (!index) {
    let creatures: Creature[] = [];
    try {
      creatures = Object.values(JSON.parse(readFileSync(PATH, "utf8")) as Record<string, Creature>);
    } catch {
      // No bestiary (a checkout without data/): creatures stay unknown.
    }
    const byName = new Map(creatures.map((c) => [c.name.toLowerCase(), c] as const));
    const byBody = new Map<number, Creature>();
    // A body several creatures share goes to the least famous, the commonest.
    for (const c of [...creatures].sort((a, b) => (a.fame ?? 0) - (b.fame ?? 0))) {
      if (c.body !== undefined && !byBody.has(c.body)) {
        byBody.set(c.body, c);
      }
    }
    index = { byName, byBody };
  }
  return index;
}

/** The bestiary's entry for a creature seen in the game: by its name, else by its body. */
export function creatureFor(name: string, graphic?: number): Creature | null {
  const { byName, byBody } = load();
  return byName.get(name.toLowerCase()) ?? (graphic !== undefined ? (byBody.get(graphic) ?? null) : null);
}

export const level = (loss: number): DangerLevel => (loss < 0.3 ? "low" : loss < 0.7 ? "medium" : loss < 1.2 ? "high" : "deadly");

/**
 * How a fight would likely go, as a share of the fighter's health lost before the creature dies: AOS hit
 * chances, damage bonuses and armour, roughly. Good for telling a rat from a lich, not for a duel.
 */
export function danger(c: Creature, me: Fighter): Danger {
  const skills = c.skills ?? {};
  const hitChance = (attack: number, defend: number) => Math.max(0.02, Math.min(1, (attack + 20) / ((defend + 20) * 2)));
  const theirAttack = Math.max(mid(skills.Wrestling), mid(skills.Archery));
  let mine = hitChance(me.weapon, theirAttack) * me.damage * (1 + me.tactics / 160 + me.anatomy / 200);
  mine *= 1 - mid(c.resist?.physical) / 100;
  let theirs = hitChance(theirAttack, me.parry / 2 + me.weapon / 2) * mid(c.damage) * (1 + mid(skills.Tactics) / 160);
  theirs *= 1 - (me.armor ?? 15) / 100;
  let theirPerSecond = theirs / 2.75;
  if (c.ai === "mage" && mid(skills.Magery) > 0) {
    theirPerSecond += ((mid(skills.Magery) / 100) * 22) / 4.5; // roughly a damage spell every 4.5 s
  }
  const seconds = mid(c.hits) / Math.max(0.1, mine / me.swing);
  const loss = Math.round(((theirPerSecond * seconds) / me.hits) * 100) / 100;
  return { seconds: Math.round(seconds * 10) / 10, loss, level: level(loss) };
}
