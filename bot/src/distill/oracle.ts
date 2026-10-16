// The danger oracle: labels a fight against a creature from the bestiary's estimate, for states a
// teacher has not answered (or to check one that has). them.creature.loss is the share of our health
// now that a whole fight with that creature would cost (brain/bestiary.ts, the model lab/bestiary.py
// uses); the rest of the fight costs about that times the creature's health left. Outcome rows from the
// arena taught a model to keep swinging at a grizzly bear (2026-10-15); this says when not to.
import type { DuelSnapshot } from "../brain/types.ts";
import type { TrainingState } from "./states.ts";
import type { LabeledState } from "./label.ts";

/** Above this share of our health now, the rest of the fight is not worth staying for. */
export const LEAVE = 0.9;
/** Above this, and hurt, heal first. */
export const CAREFUL = 0.5;

/** The share of our health now that the rest of the fight would likely cost; null against a player. */
export function costLeft(s: DuelSnapshot): number | null {
  const c = s.them.creature;
  return c ? c.loss * (s.them.healthPct / 100) : null;
}

/** The oracle's answer over the question's options, or null when it has no view (a player, no options). */
export function oracleAnswer(s: DuelSnapshot, options: string[]): { choice: string; probabilities: Record<string, number> } | null {
  const cost = costLeft(s);
  if (cost === null || options.length < 2) {
    return null;
  }
  const health = s.us.hits / Math.max(1, s.us.hitsMax);
  const has = (k: string) => options.includes(k);
  const bandaging = (s.us.bandagingForMs ?? 0) > 0;
  let pick: string;
  if (cost >= LEAVE && has("move:retreat")) {
    pick = health < 0.35 && has("heal:potion") ? "heal:potion" : "move:retreat";
  } else if (cost >= CAREFUL && health < 0.6) {
    pick = !bandaging && has("heal:bandage") ? "heal:bandage" : has("heal:potion") ? "heal:potion" : "attack:swing";
  } else {
    pick = has("attack:swing") ? "attack:swing" : options[0];
  }
  // Soft, as a teacher's distribution: the oracle is a rough model, not a certainty.
  const rest = 0.25 / (options.length - 1);
  const probabilities = Object.fromEntries(options.map((k) => [k, k === pick ? 0.75 : rest]));
  return { choice: pick, probabilities };
}

/** States labelled by the oracle, in the shape of a teacher's labels; states it has no view on are left out. */
export function oracleLabels(states: TrainingState[], snapshots: Map<string, DuelSnapshot>): LabeledState[] {
  const out: LabeledState[] = [];
  for (const t of states) {
    const s = snapshots.get(t.id);
    const options = Object.keys(t.questions.move?.criteria ?? {});
    const a = s ? oracleAnswer(s, options) : null;
    if (a) {
      out.push({ ...t, teacher: { model: "oracle:bestiary", probabilities: a.probabilities, inputTokens: 0 } });
    }
  }
  return out;
}
