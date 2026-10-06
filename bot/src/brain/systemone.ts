// Client for the System One API (POST /v1/systemone), spoken by TypeSafe's Jev and by
// laya-serve alike. The two differ only in base URL, key and model id.

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  /** option -> description */
  criteria: Record<string, string>;
};
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type NoulQuestion = { type: "noul"; instructions: string };
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export type ChoiceAnswer = {
  choice: string;
  /** option -> probability; filled in from `choice` when the backend sends no distribution */
  probabilities: Record<string, number>;
  confidence: number;
};

export type Decision = {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage: { inputTokens: number; outputTokens: number };
  /** Round trip as seen by the bot, and inference time when the server reports it. */
  latencyMs: number;
  inferenceMs?: number;
};

export type Backend = {
  /** "random": no server; every legal option equally likely, one of them picked at random. */
  name: "laya" | "jev" | "random";
  url: string;
  /** Defaults to /v1/systemone; FreeJev serves the same body at /api/v1/decisions. */
  path?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
};

type RawAnswer = {
  type?: string;
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  answer_confidence?: number;
};

export async function systemOne(
  backend: Backend,
  state: string | Record<string, unknown>,
  questions: Record<string, ChoiceQuestion>,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<Decision> {
  const started = performance.now();
  if (backend.name === "random") {
    return randomDecision(questions, performance.now() - started);
  }
  const response = await fetch(`${backend.url.replace(/\/$/, "")}${backend.path ?? "/v1/systemone"}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // FreeJev bills per request and requires one key per intended call; others ignore it.
      "idempotency-key": idempotencyKey,
      ...(backend.apiKey ? { authorization: `Bearer ${backend.apiKey}` } : {}),
    },
    body: JSON.stringify({ ...(backend.model ? { model: backend.model } : {}), state, questions }),
    signal: AbortSignal.timeout(backend.timeoutMs ?? 5_000),
  });
  const latencyMs = performance.now() - started;
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`${backend.name} answered ${response.status}: ${detail}`);
  }
  const body = (await response.json()) as {
    model?: string;
    answers?: Record<string, RawAnswer>;
    usage?: { input_tokens?: number; output_tokens?: number };
    /** laya-serve: the checkpoint that answered ("/models/neo-duel-v8-dagger-all"). */
    routing?: { repo?: string };
  };

  const answers: Record<string, ChoiceAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const raw = body.answers?.[id];
    if (!raw?.choice) {
      throw new Error(`${backend.name} returned no answer for "${id}"`);
    }
    answers[id] = {
      choice: raw.choice,
      probabilities: raw.probabilities ?? oneHot(Object.keys(question.criteria), raw.choice),
      confidence: raw.answer_confidence ?? raw.confidence ?? 1,
    };
  }

  const timing = response.headers.get("x-inference-time-ms");
  return {
    // laya-serve names every checkpoint "laya-rl-agent"; the checkpoint's folder tells them apart.
    model: (backend.name === "laya" && body.routing?.repo?.split("/").filter(Boolean).pop()) || body.model || backend.model || backend.name,
    answers,
    usage: { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 },
    latencyMs,
    inferenceMs: timing ? Number(timing) : undefined,
  };
}

const oneHot = (options: string[], choice: string) =>
  Object.fromEntries(options.map((o) => [o, o === choice ? 1 : 0]));

/** Equal probabilities and a choice at random, for the random baseline. */
function randomDecision(questions: Record<string, ChoiceQuestion>, latencyMs: number): Decision {
  const answers: Record<string, ChoiceAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const options = Object.keys(question.criteria);
    const choice = options[Math.floor(Math.random() * options.length)];
    // The pick a hair above the rest, so that whatever takes the most likely option takes it.
    const rest = (1 - 1e-6) / options.length;
    const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? rest + 1e-6 : rest]));
    answers[id] = { choice, probabilities, confidence: 1 / options.length };
  }
  return { model: "random", answers, usage: { inputTokens: 0, outputTokens: 0 }, latencyMs };
}
