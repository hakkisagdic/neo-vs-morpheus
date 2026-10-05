// Labels training states with a teacher's full answer distribution (Jev by default).
// FreeJev rules: one request at a time, at most 30 a minute, a fresh idempotency key per call.
// A call is never repeated: FreeJev answers a repeated key with 409, not with the stored answer.
import { appendFile, readFile } from "node:fs/promises";
import type { Backend } from "../brain/systemone.ts";
import { systemOne } from "../brain/systemone.ts";
import type { TrainingState } from "./states.ts";

export type LabeledState = TrainingState & {
  teacher: { model: string; probabilities: Record<string, number>; inputTokens: number };
};

const MIN_GAP_MS = 2_100;
const MAX_FAILURES = 8;
/** A rate limit (429) clears with time: waited out longer than other failures, up to about 2.5 hours. */
const MAX_RATE_LIMITED = 30;

export async function readJsonl<T>(path: string): Promise<T[]> {
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
  // A state is done if its id or its text was labeled: the same state can reappear under a new id.
  const previous = await readJsonl<LabeledState>(outPath);
  const done = new Set(previous.flatMap((s) => [s.id, s.state]));
  // A question with one legal option has one answer: nothing to learn, nothing to pay for.
  const choices = (s: TrainingState) => Math.max(...Object.values(s.questions).map((q) => Object.keys(q.criteria).length));
  const todo = states.filter((s) => !done.has(s.id) && !done.has(s.state) && choices(s) > 1).slice(0, limit);
  log(`${states.length} states, ${previous.length} already labeled, labeling ${todo.length} with ${teacher.name}`);

  // Ctrl-C or SIGTERM stops after the call in flight: a call cut off mid-request stays "running"
  // on FreeJev and blocks the account until it clears.
  let stopping = false;
  const stop = () => {
    stopping = true;
    log("stopping after the current call");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let labeled = 0;
  let last = 0;
  let failures = 0;
  for (const s of todo) {
    if (stopping) {
      break;
    }
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
      const message = (err as Error).message.slice(0, 200);
      const status = /answered (\d{3})/.exec(message)?.[1];
      // Transient: a 5xx (the proxy gave up on a slow call, which FreeJev may still be running), a
      // 409 (that call still runs), a 429 (the rate limit: FreeJev stopped a run after ~1,000 calls
      // in an hour) or no answer at all. FreeJev never hands back an answer for a repeated key, so
      // back off (1, 2, 4, then 5 minutes) and go on with a new call; the state is left for the next
      // run. Failed calls are not billed. Other errors stop the run.
      const transient = status === undefined || status === "409" || status === "429" || status.startsWith("5");
      if (!transient || failures >= (status === "429" ? MAX_RATE_LIMITED : MAX_FAILURES)) {
        log(`stopping: ${message}`);
        break;
      }
      failures++;
      const pause = Math.min(60_000 * 2 ** (failures - 1), 300_000);
      log(`${status ? `jev answered ${status}` : `no answer (${message})`}; going on in ${pause / 60_000} min (${failures} in a row)`);
      await new Promise((r) => setTimeout(r, pause));
      continue;
    }
    const record: LabeledState = {
      ...s,
      teacher: { model: d.model, probabilities: d.answers.move.probabilities, inputTokens: d.usage.inputTokens },
    };
    await appendFile(outPath, `${JSON.stringify(record)}\n`);
    labeled++;
    failures = 0;
    if (labeled % 25 === 0) {
      log(`${labeled}/${todo.length} labeled`);
    }
  }
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  return labeled;
}
