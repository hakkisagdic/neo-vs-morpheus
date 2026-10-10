// Who decides how to train a skill ("kasma"): the scripted trainer, or a System One model (Laya,
// Jev) or a random pick answering one choice question per step. UO Bench's skill tracks compare
// them from the same start: how much Magery each gains in a fixed time, and how soon each gets to
// a goal. The model is told what a player would see: its skills and mana, and for every circle the
// practice spell, its mana and its chance to succeed.
//
// ModernUO (ML rules, MagerySpell.GetCastSkills): a spell of circle c succeeds with chance
// (skill - min) / 40, min from a table (-18, -4, 10, 24, 38, 52, 66, 80), not RunUO's
// (c - 1) * 100 / 7 - 20. Below min a cast is "too difficult" and never gains; at or above min + 40
// it is "no challenge"; in between it can gain whether it succeeds or fizzles.
// Meditation puts you in a trance with chance (50 + 2 × (skill − mana missing)) %, and every try
// keeps the next skill waiting 10 s; in a trance mana comes back faster, and a cast ends it.
import { modelBackend } from "../brain/backends.ts";
import { type Backend, systemOne } from "../brain/systemone.ts";
import { spell } from "../uo/spells.ts";
import type { BrainKind } from "./match.ts";

/** Harmless practice spell for each circle (self or ground targeted). */
export const PRACTICE: Record<number, string> = {
  1: "nightSight",
  2: "protection",
  3: "bless",
  4: "greaterHeal",
  5: "magicReflection",
  6: "invisibility",
  7: "energyField",
  8: "earthquake",
};

/** The least Magery a circle can gain from (ModernUO's table for ML, from Core.ML's _requiredSkill). */
const CIRCLE_MIN = [-18, -4, 10, 24, 38, 52, 66, 80];
export const circleMin = (circle: number) => CIRCLE_MIN[circle - 1];
export const successChance = (skill: number, circle: number) => Math.min(1, Math.max(0, (skill - circleMin(circle)) / 40));

/** The chance that Meditation puts you in a trance now. */
export const tranceChance = (meditation: number, missing: number) => Math.min(1, Math.max(0, (50 + (meditation - missing) * 2) / 100));

/** Mana a second (ModernUO, ML rules) from Int and Meditation alone: no Focus, armour or items. */
export function manaPerSecond(int: number, meditation: number, trance: boolean): number {
  const med = (int + meditation * 3) * (meditation < 100 ? 0.025 : 0.0275);
  return 0.1 * (2 + Math.floor(med + (trance ? Math.min(med, 13) : 0)));
}

/** The circle whose success chance is closest to 50%. */
export function bestCircle(skill: number): number {
  let best = 1;
  for (let c = 1; c <= 8; c++) {
    if (Math.abs(successChance(skill, c) - 0.5) < Math.abs(successChance(skill, best) - 0.5)) {
      best = c;
    }
  }
  return best;
}

export type TrainAction = { kind: "cast"; circle: number } | { kind: "meditate" } | { kind: "evalInt" };

export type TrainState = {
  magery: number;
  meditation: number;
  evalInt: number;
  int: number;
  mana: number;
  manaMax: number;
  meditating: boolean;
  /** Seconds until the next skill can be used (after Meditation 10 s, after Eval Int 1 s). */
  skillReadyIn: number;
  casts: number;
  fizzles: number;
  /** Magery gained since the session began, and the session's seconds so far. */
  gained: number;
  seconds: number;
};

export type TrainChoice = {
  /** The option taken ("cast:4", "meditate", "evalInt"). */
  key: string;
  /** The checkpoint that answered, "rules", "random", or "forced" when one option was left. */
  model: string;
  latencyMs: number;
  probabilities?: Record<string, number>;
};

export interface TrainBrain {
  readonly name: string;
  decide(s: TrainState): Promise<TrainChoice>;
}

export const TRAIN_QUESTION = "Which move raises your Magery the fastest from here?";
/** The training state and question as models read them; recorded with every session. */
export const TRAIN_FORMAT = "skill-3";

/** The moves open in a state, as option -> what a player would know about it. */
export function trainOptions(s: TrainState): Record<string, string> {
  const options: Record<string, string> = {};
  for (let circle = 1; circle <= 8; circle++) {
    const sp = spell(PRACTICE[circle]);
    const chance = successChance(s.magery, circle);
    if (chance > 0 && s.mana >= sp.mana) {
      options[`cast:${circle}`] = `Cast ${sp.name} (circle ${circle}, ${sp.mana} mana): about ${Math.round(100 * chance)}% to succeed`;
    }
  }
  const wait = s.skillReadyIn > 0 ? Math.ceil(s.skillReadyIn) : 0;
  if (s.mana < s.manaMax) {
    options.meditate = s.meditating
      ? "Keep meditating"
      : wait
        ? `Rest until skills can be used (${wait} s), then meditate`
        : `Meditate: about ${Math.round(100 * tranceChance(s.meditation, s.manaMax - s.mana))}% to enter a trance`;
  }
  options.evalInt = `Use Evaluating Intelligence${wait ? ` in ${wait} s` : ""}: trains only Eval Int`;
  return options;
}

export function describeTraining(s: TrainState): string {
  const wait = s.skillReadyIn > 0 ? Math.ceil(s.skillReadyIn) : 0;
  return [
    "Ultima Online skill training: raise Magery as fast as you can.",
    `Skills: Magery ${s.magery.toFixed(1)}, Meditation ${s.meditation.toFixed(1)}, Evaluating Intelligence ${s.evalInt.toFixed(1)}.`,
    `Mana ${s.mana} of ${s.manaMax}, ${s.meditating ? "in a meditative trance" : "not meditating"}. Mana comes back ${manaPerSecond(s.int, s.meditation, false).toFixed(1)} a second, ${manaPerSecond(s.int, s.meditation, true).toFixed(1)} in a trance; a cast or a skill use ends a trance.`,
    "A cast can raise Magery whether it succeeds or fizzles, as long as its chance is above 0% and below 100%; a fizzle uses reagents but no mana.",
    `Skills ${wait ? `can be used again in ${wait} s` : "can be used now"}: a try at Meditation keeps the next one waiting 10 s, Eval Int 1 s.`,
    `So far: ${s.casts} casts, ${s.fizzles} fizzled; Magery ${s.gained >= 0 ? "+" : ""}${s.gained.toFixed(1)} in ${Math.round(s.seconds / 60)} minutes.`,
  ].join("\n");
}

export function actionOf(key: string): TrainAction {
  if (key.startsWith("cast:")) {
    return { kind: "cast", circle: Number(key.slice("cast:".length)) };
  }
  return key === "meditate" ? { kind: "meditate" } : { kind: "evalInt" };
}

/** Waits out what is left of a decision time (decisionMs after `started`), however early timers fire. */
async function pace(started: number, decisionMs = 0): Promise<void> {
  for (let wait = decisionMs - (performance.now() - started); wait > 0; wait = decisionMs - (performance.now() - started)) {
    await new Promise((r) => setTimeout(r, Math.max(1, wait)));
  }
}

/**
 * The scripted trainer: the circle whose chance is nearest 50%; meditation once a trance is down
 * to an even chance (or a cast no longer fits), and in a trance back to nearly full mana. `evalInt`: practise Eval Int while waiting for mana, every few seconds, as the trainer
 * always did; UO Bench's rules player trains Magery alone.
 */
export class RuleTrainBrain implements TrainBrain {
  readonly name = "rules";
  readonly decisionMs?: number;
  readonly evalInt: boolean;
  #lastEval = 0;

  constructor(decisionMs?: number, evalInt = false) {
    this.decisionMs = decisionMs;
    this.evalInt = evalInt;
  }

  async decide(s: TrainState): Promise<TrainChoice> {
    const started = performance.now();
    const circle = bestCircle(s.magery);
    const low = s.mana < spell(PRACTICE[circle]).mana + 5;
    // Mana spent down to an even chance of a trance: meditate now, while one is still likely.
    const trance = !s.meditating && tranceChance(s.meditation, s.manaMax - s.mana) <= 0.5;
    let key = `cast:${circle}`;
    if (low || trance || (s.meditating && s.mana < s.manaMax * 0.9)) {
      key = this.evalInt && !s.meditating && Date.now() - this.#lastEval > 3_000 ? "evalInt" : "meditate";
      if (key === "evalInt") {
        this.#lastEval = Date.now();
      }
    }
    await pace(started, this.decisionMs);
    return { key, model: "rules", latencyMs: performance.now() - started };
  }
}

/** Seconds from the start of a cast to the next one: its delay, then the recovery. */
const castSeconds = (circle: number) => (2 + circle) * 0.25 + 1.5;

/**
 * Expected Magery gains a second from practising a circle (ModernUO, AOS rules): a cast gains with
 * chance g/2 + p(1 - p)/4, where g = ((700 - all skills)/700 + (100 - Magery)/100)/2 and p is the
 * circle's success chance (no gain at p = 0 or 1); only a success costs mana, and while casting
 * drains mana faster than it comes back, part of the time goes to meditation.
 */
export function castScore(s: TrainState, circle: number): number {
  const p = successChance(s.magery, circle);
  if (p <= 0 || p >= 1) {
    return 0;
  }
  const g = ((700 - (s.magery + s.meditation + s.evalInt)) / 700 + (100 - s.magery) / 100) / 2;
  const seconds = castSeconds(circle);
  const drain = (p * spell(PRACTICE[circle]).mana) / seconds - manaPerSecond(s.int, s.meditation, false);
  const trance = manaPerSecond(s.int, s.meditation, true);
  return ((g / 2 + (p * (1 - p)) / 4) / seconds) * (drain > 0 ? trance / (drain + trance) : 1);
}

/**
 * The trainer worked out from ModernUO's formulas: the circle with the most expected gains a
 * second (castScore: often the hardest one it can cast, since fizzles gain too and cost no mana),
 * meditation only when that circle spends mana faster than it comes back, or when it runs out.
 */
export class OracleTrainBrain implements TrainBrain {
  readonly name = "oracle";
  readonly decisionMs?: number;

  constructor(decisionMs?: number) {
    this.decisionMs = decisionMs;
  }

  /** The circle to practise now, with its score. */
  static best(s: TrainState): { circle: number; score: number } {
    let best = { circle: bestCircle(s.magery), score: 0 };
    for (let circle = 1; circle <= 8; circle++) {
      const score = castScore(s, circle);
      if (score > best.score) {
        best = { circle, score };
      }
    }
    return best;
  }

  async decide(s: TrainState): Promise<TrainChoice> {
    const started = performance.now();
    const { circle } = OracleTrainBrain.best(s);
    const p = successChance(s.magery, circle);
    const cost = spell(PRACTICE[circle]).mana;
    const draining = (p * cost) / castSeconds(circle) > manaPerSecond(s.int, s.meditation, false);
    // While casting spends mana, a trance pays: try one once the odds come down to about even
    // (below 30% a try mostly wastes its 10 s, so cast on until the mana runs out), stay in it to 90%.
    const trance = tranceChance(s.meditation, s.manaMax - s.mana);
    const meditate = s.mana < cost || (draining && (s.meditating ? s.mana < s.manaMax * 0.9 : trance >= 0.3 && trance <= 0.5));
    await pace(started, this.decisionMs);
    return { key: meditate ? "meditate" : `cast:${circle}`, model: "oracle", latencyMs: performance.now() - started };
  }
}

/** A System One backend (Laya, Jev, or the random pick) answering the training question. */
export class ModelTrainBrain implements TrainBrain {
  readonly backend: Backend;
  readonly decisionMs?: number;

  constructor(backend: Backend, decisionMs?: number) {
    this.backend = backend;
    this.decisionMs = decisionMs;
  }

  get name(): string {
    return this.backend.name;
  }

  async decide(s: TrainState): Promise<TrainChoice> {
    const started = performance.now();
    const options = trainOptions(s);
    const keys = Object.keys(options);
    let key = keys[0];
    let model = "forced";
    let probabilities: Record<string, number> | undefined;
    if (keys.length > 1) {
      const d = await systemOne(this.backend, describeTraining(s), { move: { type: "choice", instructions: TRAIN_QUESTION, criteria: options } });
      const answer = d.answers.move;
      probabilities = answer?.probabilities;
      // The answer's own choice when it is one of the options, else its likeliest option.
      key = answer && keys.includes(answer.choice) ? answer.choice : keys.reduce((a, b) => ((probabilities?.[b] ?? 0) > (probabilities?.[a] ?? 0) ? b : a));
      model = d.model;
    }
    await pace(started, this.decisionMs);
    return { key, model, latencyMs: performance.now() - started, probabilities };
  }
}

/** The trainer for a brain as a fighter spec names it ("laya", "rules@4000"), with its decision time. */
export function makeTrainBrain(kind: BrainKind, decisionMs?: number): TrainBrain {
  if (kind === "rules") {
    return new RuleTrainBrain(decisionMs);
  }
  return kind === "oracle" ? new OracleTrainBrain(decisionMs) : new ModelTrainBrain(modelBackend(kind), decisionMs);
}
