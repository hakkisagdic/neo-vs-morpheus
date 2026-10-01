// Teacher labels carried over to the current mage question. A label is the teacher's answer to
// the question it was asked. When the question changes, the answer is carried over instead of
// bought again: options the new question leaves out lose their probability and the rest are
// renormalised. Out of reach, where a damage option used to mean chasing, its mass goes to the
// chase option; an interrupt cannot reach them there, so its mass is dropped like any illegal
// move. The snapshot is rebuilt from its run or its sampler and must still render to the stored
// text, and every converted row records what it came from.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FORMAT, compositeQuestion, describeDuel, isOutOfReach } from "../brain/duel-policy.ts";
import type { DuelSnapshot } from "../brain/types.ts";
import type { LabeledState } from "./label.ts";
import { movementSnapshots, reagentShortageSnapshots, sampledSnapshots } from "./states.ts";

export type ConvertedLabel = LabeledState & {
  teacher: LabeledState["teacher"] & { converted?: { from: string; kept: number } };
};

/** Snapshots for label ids: `run:<file>:<i>`, `sampled:<seed>:<i>`, `movement:<seed>:<i>`. */
export async function snapshotsFor(ids: string[], runsDir: string): Promise<Map<string, DuelSnapshot>> {
  const out = new Map<string, DuelSnapshot>();
  const draws = new Map<string, number>(); // "kind:seed" -> how many to draw
  const files = new Set<string>();
  for (const id of ids) {
    const [kind, a, b] = id.split(":");
    if (kind === "run") {
      files.add(a);
    } else if (kind === "sampled" || kind === "movement" || kind === "reagents") {
      draws.set(`${kind}:${a}`, Math.max(draws.get(`${kind}:${a}`) ?? 0, Number(b) + 1));
    }
  }
  for (const file of files) {
    // Runs an NPC leftover spoiled were moved aside; their states are still valid duel moments.
    const text = await readFile(join(runsDir, file), "utf8").catch(() => readFile(join(runsDir, "npc-leftover", file), "utf8"));
    const run = JSON.parse(text) as { records: { snapshot: DuelSnapshot }[] };
    run.records.forEach((r, i) => out.set(`run:${file}:${i}`, r.snapshot));
  }
  for (const [key, n] of draws) {
    const [kind, seed] = key.split(":");
    const make = { sampled: sampledSnapshots, movement: movementSnapshots, reagents: reagentShortageSnapshots }[kind];
    const snapshots = make ? make(n, Number(seed)) : [];
    snapshots.forEach((s, i) => out.set(`${kind}:${seed}:${i}`, s));
  }
  return out;
}

/**
 * Labels that must be asked again instead of carried over: out of reach the old question spread
 * chasing over nine attack options, and their summed probability overstates it (converted labels
 * said "chase" in 90-100% of those states, the teacher asked afresh in 32-93%).
 */
export const needsRelabel = (row: LabeledState, s: DuelSnapshot) =>
  (row.format?.question ?? "composite-1") === "composite-1" && isOutOfReach(s);

/** The label asked with the current question, or why it cannot be carried over. */
export function convertLabel(row: LabeledState, s: DuelSnapshot): ConvertedLabel | string {
  const from = row.format?.question ?? "composite-1";
  if (from === FORMAT.question) {
    return row;
  }
  if (from !== "composite-1" && from !== "composite-2") {
    return `no conversion from ${from}`;
  }
  if (describeDuel(s) !== row.state) {
    return "the snapshot no longer renders to the stored text";
  }
  const current = compositeQuestion(s);
  const old = row.teacher.probabilities;
  // A conversion only takes options away (illegal now, or wasted): an option the teacher never
  // saw (a spell added since, hold, dodge) would read as one it gave no chance, so it stays out.
  // Chasing is the old attack options under a new name.
  const criteria = Object.fromEntries(
    Object.entries(current.move.criteria).filter(([k]) => k in old || (k === "damage:chase" && from === "composite-1")),
  );
  const questions = { move: { ...current.move, criteria } };
  const attack = Object.entries(old)
    .filter(([k]) => k.startsWith("damage:"))
    .reduce((sum, [, p]) => sum + p, 0);
  const probabilities: Record<string, number> = {};
  for (const key of Object.keys(questions.move.criteria)) {
    probabilities[key] = key === "damage:chase" ? attack : (old[key] ?? 0);
  }
  const kept = Object.values(probabilities).reduce((a, b) => a + b, 0);
  if (kept <= 0) {
    return "the teacher chose only options the new question leaves out";
  }
  for (const key of Object.keys(probabilities)) {
    probabilities[key] /= kept;
  }
  return {
    ...row,
    module: "mage",
    format: FORMAT,
    questions,
    teacher: { ...row.teacher, probabilities, converted: { from, kept: Math.round(kept * 1000) / 1000 } },
  };
}
