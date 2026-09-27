// Labels training states with a teacher's full answer distribution (Jev by default).
// FreeJev rules: one request at a time, at most 30 a minute, never retry a billable call on
// its own; a response lost in transit is retried once with the same idempotency key.
import { appendFile, readFile } from "node:fs/promises";
import type { Backend } from "../brain/systemone.ts";
import { systemOne } from "../brain/systemone.ts";
import type { TrainingState } from "./states.ts";

export type LabeledState = TrainingState & {
  teacher: { model: string; probabilities: Record<string, number>; inputTokens: number };
};

const MIN_GAP_MS = 2_100;

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

export async function labelStates(
  teacher: Backend,
  inPath: string,
  outPath: string,
  limit: number,
  log: (m: string) => void,
): Promise<number> {
  const states = await readJsonl<TrainingState>(inPath);
  const done = new Set((await readJsonl<LabeledState>(outPath)).map((s) => s.id));
  const todo = states.filter((s) => !done.has(s.id)).slice(0, limit);
  log(`${states.length} states, ${done.size} already labeled, labeling ${todo.length} with ${teacher.name}`);

  let labeled = 0;
  let last = 0;
  for (const s of todo) {
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    last = Date.now();
    const key = crypto.randomUUID();
    let d;
    try {
      d = await systemOne(teacher, s.state, s.questions, key);
    } catch (err) {
      const message = (err as Error).message;
      if (/answered \d{3}/.test(message)) {
        log(`stopping: ${message}`); // an HTTP error is an answer; do not re-bill it
        break;
      }
      log(`response lost (${message}); retrying once with the same key`);
      try {
        d = await systemOne(teacher, s.state, s.questions, key);
      } catch (again) {
        log(`stopping: ${(again as Error).message}`);
        break;
      }
    }
    const record: LabeledState = {
      ...s,
      teacher: { model: d.model, probabilities: d.answers.move.probabilities, inputTokens: d.usage.inputTokens },
    };
    await appendFile(outPath, `${JSON.stringify(record)}\n`);
    labeled++;
    if (labeled % 25 === 0) {
      log(`${labeled}/${todo.length} labeled`);
    }
  }
  return labeled;
}
