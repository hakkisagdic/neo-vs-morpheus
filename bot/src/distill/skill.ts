// Training rows for skill training ("kasma"): states sampled across the ranges a mage meets while
// training Magery (not taken from UO Bench's sessions, whose states the bench scores), labelled
// by the oracle trainer (src/game/train-brain.ts), in the same form as the duel rows. Necromancy
// and Chivalry: the same, over the ranges their trainees meet, in their own formats.
import { random } from "../bench/stats.ts";
import type { ChoiceQuestion } from "../brain/systemone.ts";
import {
  type ChivalryState,
  type NecroState,
  OracleTrainBrain,
  type SkillState,
  TRAIN_FORMATS,
  type TrainSkill,
  type TrainState,
  describeTraining,
  trainOptions,
  trainQuestion,
} from "../game/train-brain.ts";
import { type NecroForm, castChance } from "../game/train-schools.ts";
import { spell } from "../uo/spells.ts";

/** A row as training/finetune.py reads it (the duel rows' form), for the "train" module. */
export type SkillRow = {
  id: string;
  source: "sampled";
  module: "train";
  format: { describe: string; question: string };
  state: string;
  questions: { move: ChoiceQuestion };
  teacher: { model: string; probabilities: Record<string, number>; inputTokens: number };
};

/** The oracle's choice gets this much of the teacher's distribution; the other options share the rest. */
const CHOSEN = 0.9;

/** A training state somewhere a Magery trainee can be: skills, stats and mana drawn at random (seeded). */
export function sampleTrainState(next: () => number): TrainState {
  const between = (lo: number, hi: number) => lo + next() * (hi - lo);
  const tenth = (x: number) => Math.round(x * 10) / 10;
  const int = Math.round(between(50, 125));
  const mana = Math.round(between(0, int));
  const magery = tenth(between(30, 99.9));
  const casts = Math.round(between(0, 1500));
  const seconds = Math.round(between(0, 5400));
  return {
    magery,
    meditation: tenth(between(30, 100)),
    evalInt: tenth(between(0, 100)),
    int,
    mana,
    manaMax: int,
    meditating: mana < int && next() < 0.3,
    skillReadyIn: next() < 0.6 ? 0 : tenth(between(0, 10)),
    casts,
    fizzles: Math.round(casts * between(0, 0.8)),
    gained: tenth(between(0, Math.max(0, magery - 30))),
    seconds,
  };
}

const NECRO_FORMS: NecroForm[] = ["wraithForm", "horrificBeast", "lichForm", "vampiricEmbrace"];

/** A state somewhere a Necromancy trainee can be: in no form, or in one its skill can take (seeded). */
export function sampleNecroState(next: () => number): NecroState {
  const between = (lo: number, hi: number) => lo + next() * (hi - lo);
  const tenth = (x: number) => Math.round(x * 10) / 10;
  const int = Math.round(between(50, 125));
  const mana = Math.round(between(0, int));
  const necromancy = tenth(between(30, 99.9));
  const spiritSpeak = tenth(between(30, 100));
  const meditation = tenth(between(30, 100));
  const forms = NECRO_FORMS.filter((f) => castChance(spell(f), necromancy) > 0);
  const form = next() < 0.5 ? null : (forms[Math.floor(next() * forms.length)] ?? null);
  const hitsMax = Math.round(between(70, 110));
  const casts = Math.round(between(0, 1500));
  return {
    skill: "necromancy",
    necromancy,
    spiritSpeak,
    meditation,
    allSkills: tenth(necromancy + spiritSpeak + meditation),
    int,
    hits: Math.round(hitsMax * between(form === "lichForm" ? 0.2 : 0.6, 1)),
    hitsMax,
    mana,
    manaMax: int,
    form,
    meditating: mana < int && next() < 0.3,
    skillReadyIn: next() < 0.6 ? 0 : tenth(between(0, 10)),
    casts,
    fizzles: Math.round(casts * between(0, 0.8)),
    gained: tenth(between(0, Math.max(0, necromancy - 30))),
    seconds: Math.round(between(0, 5400)),
  };
}

/** A state somewhere a Chivalry trainee can be (seeded): its other skills from none to two at 100. */
export function sampleChivalryState(next: () => number): ChivalryState {
  const between = (lo: number, hi: number) => lo + next() * (hi - lo);
  const tenth = (x: number) => Math.round(x * 10) / 10;
  const int = Math.round(between(30, 100));
  const mana = Math.round(between(0, int));
  const chivalry = tenth(between(30, 99.9));
  const focus = tenth(between(0, 100));
  const meditation = tenth(between(30, 100));
  const casts = Math.round(between(0, 2500));
  return {
    skill: "chivalry",
    chivalry,
    focus,
    meditation,
    allSkills: tenth(chivalry + focus + meditation + between(0, 200)),
    int,
    mana,
    manaMax: int,
    // Never short of tithing: the trainer has the GM restock below 30.
    tithing: Math.round(between(30, 300_000)),
    meditating: mana < int && next() < 0.3,
    skillReadyIn: next() < 0.6 ? 0 : tenth(between(0, 10)),
    casts,
    fizzles: Math.round(casts * between(0, 0.9)),
    gained: tenth(between(0, Math.max(0, chivalry - 30))),
    seconds: Math.round(between(0, 5400)),
  };
}

const SAMPLERS: Record<TrainSkill, (next: () => number) => SkillState> = {
  magery: sampleTrainState,
  necromancy: sampleNecroState,
  chivalry: sampleChivalryState,
};

/** n sampled states of a skill's training with the oracle's answers, as training rows. */
export async function skillRows(n: number, seed = 20261007, skill: TrainSkill = "magery"): Promise<SkillRow[]> {
  const next = random(seed);
  const oracle = new OracleTrainBrain();
  const rows: SkillRow[] = [];
  const format = TRAIN_FORMATS[skill];
  for (let i = 0; i < n; i++) {
    const s = SAMPLERS[skill](next);
    const criteria = trainOptions(s);
    const keys = Object.keys(criteria);
    const { key } = await oracle.decide(s);
    const rest = keys.length > 1 ? (1 - CHOSEN) / (keys.length - 1) : 0;
    rows.push({
      id: skill === "magery" ? `skill:${seed}:${i}` : `skill-${skill}:${seed}:${i}`,
      source: "sampled",
      state: describeTraining(s),
      questions: { move: { type: "choice", instructions: trainQuestion(s), criteria } },
      teacher: { model: "oracle", probabilities: Object.fromEntries(keys.map((k) => [k, k === key ? (keys.length > 1 ? CHOSEN : 1) : rest])), inputTokens: 0 },
      module: "train",
      format: { describe: format, question: format },
    });
  }
  return rows;
}
