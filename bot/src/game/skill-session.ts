// One skill-training session ("kasma") for UO Bench: the trainee takes its template (the mage
// trainee: Magery, Meditation and Eval Int at 50), trains alone at its arena slot until it has
// trained `minutes` and reached `goal`, or `cap` minutes have gone, and the session is saved as
// runs/<stamp>-skill.json. Two scores come out of it: Magery gained in the first `minutes`, and
// the time to the goal (the cap when it was not reached).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { type Fighter, codeVersion } from "./match.ts";
import { Session } from "./session.ts";
import { TRAIN_FORMAT, makeTrainBrain } from "./train-brain.ts";
import { SkillTrainer, type TrainStep } from "./train.ts";

export type SkillSessionOptions = {
  trainee: Fighter;
  /** The session trains at least this long: the fixed-time score's window. */
  minutes: number;
  /** Magery the session trains up to, for the time-to-goal score. */
  goal: number;
  /** Minutes at most. */
  cap: number;
  slot: number;
  gm: Session;
  bench?: string;
};

export type SkillResult = {
  trainee: { name: string; brain: string; template: string; decisionMs?: number };
  /** The checkpoint that answered, for a model. */
  model?: string;
  minutes: number;
  goal: number;
  cap: number;
  startedAt: number;
  /** The skills at the start and at the end. */
  start: Record<string, number>;
  end: Record<string, number>;
  /** How long it trained, and when it reached the goal (null: not within the cap). */
  seconds: number;
  reachedAt: number | null;
  /** Magery as it rose: [seconds, Magery]. */
  progress: [number, number][];
  casts: number;
  fizzles: number;
  restocks: number;
  errors: number;
  decisions: number;
  /** Median decision time, ms. */
  latencyMs: number;
  /** The longest step, s: a step takes seconds, so minutes mean the machine or the server froze. */
  longestStepS?: number;
  /** How often each option was taken ("cast:4", "meditate", "evalInt"). */
  choices: Record<string, number>;
};

/** Magery at a time into the session, from its progress. */
export function mageryAt(r: Pick<SkillResult, "start" | "progress">, seconds: number): number {
  let magery = r.start.Magery;
  for (const [t, value] of r.progress) {
    if (t > seconds) {
      break;
    }
    magery = value;
  }
  return magery;
}

/** "Magery 50.0 -> 58.3 (+5.1 in 20 min; 70 not reached in 60 min), 412 casts" */
export function describeSkillResult(r: SkillResult): string {
  const at = mageryAt(r, r.minutes * 60) - r.start.Magery;
  const goal = r.reachedAt === null ? `${r.goal} not reached in ${Math.round(r.seconds / 60)} min` : `${r.goal} in ${(r.reachedAt / 60).toFixed(1)} min`;
  const trouble = [r.errors ? `${r.errors} failed decisions` : "", r.restocks ? `${r.restocks} restocks` : ""].filter(Boolean);
  return `Magery ${r.start.Magery.toFixed(1)} -> ${r.end.Magery.toFixed(1)} (+${at.toFixed(1)} in ${r.minutes} min; ${goal}), ${r.casts} casts, ${r.decisions} decisions at ${r.latencyMs} ms${trouble.length ? `; ${trouble.join(", ")}` : ""}`;
}

/** The longest time between one step's state and the next's, s. */
export function longestStep(steps: Pick<TrainStep, "state">[]): number {
  let longest = 0;
  for (let i = 1; i < steps.length; i++) {
    longest = Math.max(longest, steps[i].state.seconds - steps[i - 1].state.seconds);
  }
  return Math.round(longest);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

export async function runSkillSession(o: SkillSessionOptions, log: (m: string) => void): Promise<SkillResult> {
  const { trainee: f, gm, slot } = o;
  const session = await Session.bot(f.name, log);
  try {
    // The trainee's template sets its skills and pack and preps it (full mana); then its own place.
    await gm.command(`[NeoArena open ${slot}`);
    await gm.command(`[NeoTemplate ${f.name} ${f.template}`);
    await gm.command(`[NeoClear 20 ${slot}`);
    await gm.command(`[NeoPlace ${f.name} west 2 ${slot}`);
    await new Promise((r) => setTimeout(r, 1_500)); // the skills and the new place reach the client

    const brain = makeTrainBrain(f.brain, f.reactionMs);
    const trainer = new SkillTrainer(session, brain);
    trainer.on("log", (m) => log(`${f.name}: ${m}`));
    // The first call to a model backend is slow (weights to the GPU): pay it before the clock starts.
    await brain.decide(trainer.state()).catch((err) => log(`${brain.name} warm-up failed: ${(err as Error).message}`));

    const start = trainer.snapshot();
    const startedAt = Date.now();
    const ac = new AbortController();
    const cap = setTimeout(() => ac.abort(), o.cap * 60_000);
    try {
      await trainer.run(
        ac.signal,
        (s) => s.magery >= o.goal && s.seconds >= o.minutes * 60,
        async () => void (await gm.command(`[NeoPrep ${f.name}`)),
      );
    } finally {
      clearTimeout(cap);
    }
    const reachedAt = start.Magery >= o.goal ? 0 : (trainer.progress.find(([, magery]) => magery >= o.goal)?.[0] ?? null);

    const choices: Record<string, number> = {};
    for (const step of trainer.steps) {
      choices[step.choice.key] = (choices[step.choice.key] ?? 0) + 1;
    }
    const models = trainer.steps.map((s) => s.choice.model).filter((m) => m !== "forced" && m !== "rules");
    const result: SkillResult = {
      trainee: { name: f.name, brain: f.brain, template: f.template, ...(f.reactionMs !== undefined ? { decisionMs: f.reactionMs } : {}) },
      ...(models.length ? { model: models[models.length - 1] } : {}),
      minutes: o.minutes,
      goal: o.goal,
      cap: o.cap,
      startedAt,
      start,
      end: trainer.snapshot(),
      seconds: Math.round((Date.now() - startedAt) / 1000),
      reachedAt,
      progress: trainer.progress,
      casts: trainer.casts,
      fizzles: trainer.fizzles,
      restocks: trainer.restocks,
      errors: trainer.errors,
      decisions: trainer.steps.length,
      latencyMs: Math.round(median(trainer.steps.map((s) => s.choice.latencyMs))),
      longestStepS: longestStep(trainer.steps),
      choices,
    };
    await saveSkillRun(result, trainer.steps, o.bench);
    return result;
  } finally {
    session.close();
  }
}

async function saveSkillRun(result: SkillResult, steps: TrainStep[], bench?: string): Promise<void> {
  const dir = join(import.meta.dirname, "..", "..", "..", "runs");
  await mkdir(dir, { recursive: true });
  const stamp = new Date(result.startedAt).toISOString().replace(/[:.]/g, "-");
  const where = config.fleetInstance ? { instance: config.fleetInstance, ...(config.fleetLane ? { lane: config.fleetLane } : {}) } : undefined;
  const versions = { run: 1, kind: "skill", format: TRAIN_FORMAT, code: codeVersion(), ...(where ? { where } : {}), ...(bench ? { bench } : {}) };
  const name = where ? `${where.instance}--${stamp}-skill` : `${stamp}-skill`;
  await writeFile(join(dir, `${name}.json`), JSON.stringify({ versions, skill: result, steps }));
}
