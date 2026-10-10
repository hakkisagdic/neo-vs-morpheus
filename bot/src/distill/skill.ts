// Training rows for skill training ("kasma"): states sampled across the ranges a mage meets while
// training Magery (not taken from UO Bench's sessions, whose states the bench scores), labelled
// by the oracle trainer (src/game/train-brain.ts), in the same form as the duel rows.
import { random } from "../bench/stats.ts";
import type { ChoiceQuestion } from "../brain/systemone.ts";
import { OracleTrainBrain, TRAIN_FORMAT, TRAIN_QUESTION, type TrainState, describeTraining, trainOptions } from "../game/train-brain.ts";

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

/** n sampled states with the oracle's answers, as training rows. */
export async function skillRows(n: number, seed = 20261007): Promise<SkillRow[]> {
  const next = random(seed);
  const oracle = new OracleTrainBrain();
  const rows: SkillRow[] = [];
  for (let i = 0; i < n; i++) {
    const s = sampleTrainState(next);
    const criteria = trainOptions(s);
    const keys = Object.keys(criteria);
    const { key } = await oracle.decide(s);
    const rest = keys.length > 1 ? (1 - CHOSEN) / (keys.length - 1) : 0;
    rows.push({
      id: `skill:${seed}:${i}`,
      source: "sampled",
      state: describeTraining(s),
      questions: { move: { type: "choice", instructions: TRAIN_QUESTION, criteria } },
      teacher: { model: "oracle", probabilities: Object.fromEntries(keys.map((k) => [k, k === key ? (keys.length > 1 ? CHOSEN : 1) : rest])), inputTokens: 0 },
      module: "train",
      format: { describe: TRAIN_FORMAT, question: TRAIN_FORMAT },
    });
  }
  return rows;
}
