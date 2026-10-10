import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelBrain, paceLine } from "../src/brain/brains.ts";
import { checkRun } from "../src/eval/run-checks.ts";
import { describeSide } from "../src/fleet/results.ts";
import { parseBrain } from "../src/game/match.ts";
import { SCENARIOS } from "../src/eval/scenarios.ts";

describe("a decision time of one's own (the bench's equal-time tracks)", () => {
  it("reads laya@4000, jev@4000 and random@4000 as well as rules@40", () => {
    expect(parseBrain("laya@4000")).toEqual({ brain: "laya", reactionMs: 4000 });
    expect(parseBrain("jev@4000")).toEqual({ brain: "jev", reactionMs: 4000 });
    expect(parseBrain("random@250")).toEqual({ brain: "random", reactionMs: 250 });
    expect(parseBrain("rules@40")).toEqual({ brain: "rules", reactionMs: 40 });
    expect(parseBrain("laya@20000")).toBeNull();
    expect(parseBrain("laya@fast")).toBeNull();
  });

  it("waits a quick answer out, and answers at once without a decision time", async () => {
    const paced = await new ModelBrain({ name: "random", url: "" }, "composite", "mage", 60).decide(SCENARIOS[0].snapshot);
    expect(paced.latencyMs).toBeGreaterThanOrEqual(60);
    const quick = await new ModelBrain({ name: "random", url: "" }).decide(SCENARIOS[0].snapshot);
    expect(quick.latencyMs).toBeLessThan(60);
  });

  it("names a paced model apart from its usual pace", () => {
    expect(describeSide({ name: "Neo", brain: "laya", template: "mage", reactionMs: 4000 }, "neo-duel-v8")).toBe("neo-duel-v8@4000 mage");
    expect(describeSide({ name: "Neo", brain: "random", template: "dexer", reactionMs: 4000 })).toBe("random@4000 dexer");
    expect(describeSide({ name: "Neo", brain: "laya", template: "mage" }, "neo-duel-v8")).toBe("neo-duel-v8 mage");
  });

  it("finds a paced model late only past its own decision time", () => {
    const record = (latencyMs: number) => ({
      bot: "Neo",
      snapshot: { us: {} },
      decision: { brain: "jev", model: "jev", latencyMs, plan: { kind: "wait" } },
    });
    const fighters = [{ name: "Neo", brain: "jev", reactionMs: 4000 }];
    const onTime = Array.from({ length: 5 }, () => record(4010));
    expect(checkRun(onTime as never, fighters).flatMap((c) => c.problems)).toEqual([]);
    const late = Array.from({ length: 5 }, () => record(5200));
    expect(checkRun(late as never, fighters).flatMap((c) => c.problems)[0]).toMatch(/took 5200 ms/);
    // Without a decision time Jev's usual 3 s is not held against it.
    expect(checkRun(Array.from({ length: 5 }, () => record(3300)) as never, [{ name: "Neo", brain: "jev" }]).flatMap((c) => c.problems)).toEqual([]);
  });
});

describe("paced tracks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tells a paced model its pace in the state it reads, and only when asked to", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { state: string; questions: { move: { criteria: Record<string, string> } } };
      sent.push(body.state);
      return new Response(JSON.stringify({ model: "m", answers: { move: { choice: Object.keys(body.questions.move.criteria)[0] } } }), { status: 200 });
    });
    const backend = { name: "laya" as const, url: "http://x" };
    await new ModelBrain(backend, "composite", "mage", 20, true).decide(SCENARIOS[0].snapshot);
    await new ModelBrain(backend, "composite", "mage", 20).decide(SCENARIOS[0].snapshot);
    await new ModelBrain(backend, "composite", "mage", undefined, true).decide(SCENARIOS[0].snapshot);
    expect(sent[0].endsWith(paceLine(20))).toBe(true);
    expect(paceLine(4000)).toBe("Pace: you decide once every 4 s, and each move is carried out 4 s after the state it answers.");
    expect(sent[1]).not.toContain("Pace:");
    expect(sent[2]).not.toContain("Pace:"); // no decision time, nothing to tell
  });
});
