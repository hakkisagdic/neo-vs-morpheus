// DAgger (Dataset Aggregation, Ross, Gordon and Bagnell 2011): the states Laya reached in its own
// matches, answered by the scripted bot as the expert. Imitation alone only ever sees the expert's
// states; a student that strays meets states nobody labelled and its mistakes compound. Asking the
// expert about the student's states, and adding the answers to all the data so far, fixes that.
// The rows have the teacher labels' shape: today's state text and question, the expert's move as
// 70% of the target and the rest spread over the other legal moves.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RuleBrain } from "../brain/brains.ts";
import { FORMAT, compositeQuestion, describeDuel } from "../brain/duel-policy.ts";
import { MELEE_FORMAT, describeMelee, meleeQuestion } from "../brain/melee-policy.ts";
import type { ModuleName } from "../brain/types.ts";
import { checkRun } from "../eval/run-checks.ts";
import type { LabeledState } from "./label.ts";
import { type Run, runStamp, takenKey } from "./outcomes.ts";

/** How sharply the expert's move is targeted (v8-dagger used 0.7). */
export const DAGGER_TARGET = 0.7;

export type DaggerResult = { rows: LabeledState[]; states: number; agreed: number; skippedRuns: number };

/** Rows for every Laya decision in the runs since a time stamp, leaving out runs that fail the run checks. */
export async function daggerLabels(runsDir: string, since = "", log: (m: string) => void = () => {}): Promise<DaggerResult> {
  const files = (await readdir(runsDir)).filter((f) => f.endsWith(".json") && runStamp(f) >= since).sort();
  const experts: Record<ModuleName, RuleBrain> = { mage: new RuleBrain("mage"), melee: new RuleBrain("melee") };
  const seen = new Set<string>();
  const rows: LabeledState[] = [];
  let states = 0;
  let agreed = 0;
  let skippedRuns = 0;
  for (const file of files) {
    const run = JSON.parse(await readFile(join(runsDir, file), "utf8")) as Run;
    if (!run.match) {
      continue; // a skill-training session (runs/<stamp>-skill.json): no duel in it
    }
    const problems = checkRun(run.records, run.match.fighters).flatMap((c) => c.problems);
    if (problems.length) {
      log(`skipping ${file}: ${problems.join("; ")}`);
      skippedRuns++;
      continue;
    }
    for (const [index, rec] of run.records.entries()) {
      if (rec.decision.brain !== "laya") {
        continue;
      }
      states++;
      const module: ModuleName = rec.decision.module === "melee" ? "melee" : "mage";
      const melee = module === "melee";
      const state = melee ? describeMelee(rec.snapshot) : describeDuel(rec.snapshot);
      if (seen.has(state)) {
        continue;
      }
      const questions = melee ? meleeQuestion(rec.snapshot) : compositeQuestion(rec.snapshot);
      const options = Object.keys(questions.move.criteria);
      const key = takenKey(await experts[module].decide(rec.snapshot), rec.snapshot);
      if (!key || !options.includes(key) || options.length < 2) {
        continue;
      }
      seen.add(state);
      if (takenKey(rec.decision, rec.snapshot) === key) {
        agreed++;
      }
      const rest = (1 - DAGGER_TARGET) / (options.length - 1);
      rows.push({
        id: `dagger:${file}:${index}`,
        source: "run",
        module,
        format: melee ? MELEE_FORMAT : FORMAT,
        state,
        questions,
        teacher: { model: "dagger:rules", probabilities: Object.fromEntries(options.map((k) => [k, k === key ? DAGGER_TARGET : rest])), inputTokens: 0 },
      } as LabeledState);
    }
  }
  return { rows, states, agreed, skippedRuns };
}
