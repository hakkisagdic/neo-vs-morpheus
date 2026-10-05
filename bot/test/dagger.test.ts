import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DAGGER_TARGET, daggerLabels } from "../src/distill/dagger.ts";
import { runStamp } from "../src/distill/outcomes.ts";
import { SCENARIOS } from "../src/eval/scenarios.ts";

const decision = (brain: string, plan: object) => ({
  brain, model: "m", latencyMs: 40, inputTokens: 0, outputTokens: 0, module: "mage",
  mode: { choice: "damage", probabilities: { damage: 1 } }, parts: {}, plan, why: "", overrides: [],
});

describe("runStamp", () => {
  it("reads the time stamp whichever machine played the run", () => {
    expect(runStamp("mac--2026-10-05T12-00-00-000Z.json")).toBe("2026-10-05T12-00-00-000Z.json");
    expect(runStamp("2026-10-01T22-00-00-000Z.json")).toBe("2026-10-01T22-00-00-000Z.json");
    expect(runStamp("mac--2026-10-05T12.json") >= "2026-10-05").toBe(true);
    expect(runStamp("alastyr--2026-10-01T12.json") >= "2026-10-05").toBe(false);
  });
});

describe("daggerLabels", () => {
  it("labels Laya's states with the scripted bot's move, once per state, and skips the scripted bot's own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dagger-"));
    const snapshot = SCENARIOS[0].snapshot;
    const records = [
      { at: 1, bot: "Neo", decision: decision("laya", { kind: "wait" }), snapshot },
      { at: 2, bot: "Neo", decision: decision("laya", { kind: "wait" }), snapshot },
      { at: 3, bot: "Morpheus", decision: decision("rules", { kind: "wait" }), snapshot },
    ];
    await writeFile(join(dir, "mac--2026-10-05T12-00-00-000Z.json"), JSON.stringify({ match: { results: [] }, records }));
    await writeFile(join(dir, "2026-09-01T00-00-00-000Z.json"), JSON.stringify({ match: { results: [] }, records }));
    const { rows, states } = await daggerLabels(dir, "2026-10-01");
    expect(states).toBe(2);
    expect(rows).toHaveLength(1);
    const p = rows[0].teacher.probabilities;
    expect(rows[0].teacher.model).toBe("dagger:rules");
    expect(Math.max(...Object.values(p))).toBeCloseTo(DAGGER_TARGET);
    expect(Object.values(p).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(Object.keys(p)).toEqual(Object.keys(rows[0].questions.move.criteria));
  });
});
