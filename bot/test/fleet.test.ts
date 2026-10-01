import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { importedName, importRuns } from "../src/fleet/instances.ts";
import { type RunFile, describeSide, formatRows, instanceOf, runInfo, tally } from "../src/fleet/results.ts";

const run = (a: object, b: object, winners: (string | null)[], extra: Partial<RunFile> = {}): RunFile => ({
  versions: { models: {} },
  match: {
    title: "t",
    fighters: [{ name: "Neo", ...a }, { name: "Morpheus", ...b }] as RunFile["match"]["fighters"],
    startedAt: Date.parse("2026-10-01T22:00:00Z"),
    results: winners.map((winner) => ({ winner })),
    checks: [],
  },
  ...extra,
});

describe("describeSide", () => {
  it("names what decides, the build and the tactics", () => {
    expect(describeSide({ name: "Neo", brain: "laya", template: "mage", tactics: "neutral" }, "neo-duel-v8")).toBe("neo-duel-v8 mage");
    expect(describeSide({ name: "Neo", brain: "rules", template: "dexer", tactics: "kite", reactionMs: 100 })).toBe("rules@100 dexer kite");
    expect(describeSide({ name: "Neo", brain: "rules" })).toBe("rules@0 mage");
    expect(describeSide({ name: "Neo", brain: "laya" }, "laya-rl-agent")).toBe("laya (model not recorded) mage");
    expect(describeSide({ name: "EvilMageLord", brain: "npc" })).toBe("npc EvilMageLord");
  });
});

describe("tally", () => {
  it("adds both seatings of a matchup into one row", () => {
    const first = runInfo("a.json", run({ brain: "laya", template: "mage" }, { brain: "rules", template: "mage", reactionMs: 100 }, ["Neo", "Neo", "Morpheus"], { versions: { models: { Neo: "v8" } } }));
    const second = runInfo("b.json", run({ brain: "rules", template: "mage", reactionMs: 100 }, { brain: "laya", template: "mage" }, ["Morpheus", null], { versions: { models: { Morpheus: "v8" } } }));
    const rows = tally([first, second]);
    expect(rows).toHaveLength(1);
    expect(rows[0].sides).toEqual(["rules@100 mage", "v8 mage"]);
    expect(rows[0].wins).toEqual([1, 3]);
    expect(rows[0].draws).toBe(1);
    expect(formatRows(rows)).toBe("rules@100 mage vs v8 mage: 1-3 (25%), 1 draws; 2 runs");
  });

  it("leaves flagged runs out unless asked, and filters by time and instance", () => {
    const flagged = runInfo("colab--x.json", { ...run({ brain: "rules" }, { brain: "rules", reactionMs: 250 }, ["Neo"]) });
    flagged.problems = ["Neo cast late"];
    expect(tally([flagged])[0]).toMatchObject({ runs: 0, flagged: 1, wins: [0, 0] });
    expect(tally([flagged], { includeFlagged: true })[0].wins).toEqual([1, 0]);
    expect(tally([flagged], { since: Date.parse("2026-10-02T00:00:00Z") })).toEqual([]);
    expect(tally([flagged], { instance: "colab" })).toHaveLength(1);
    expect(tally([flagged], { instance: "alastyr" })).toEqual([]);
  });

  it("knows where a run was played", () => {
    expect(instanceOf("colab-a100--2026.json", run({ brain: "rules" }, { brain: "rules" }, []))).toBe("colab-a100");
    expect(instanceOf("2026.json", run({ brain: "rules" }, { brain: "rules" }, []))).toBe("mac");
    expect(instanceOf("x--2026.json", run({ brain: "rules" }, { brain: "rules" }, [], { versions: { where: { instance: "alastyr" } } }))).toBe("alastyr");
  });
});

describe("importRuns", () => {
  it("names runs after their instance once, unpacks .gz and skips broken or known files", async () => {
    expect(importedName("2026-10-01T22-00-00-000Z.json", "alastyr")).toBe("alastyr--2026-10-01T22-00-00-000Z.json");
    expect(importedName("alastyr--2026.json.gz", "alastyr")).toBe("alastyr--2026.json");
    const from = await mkdtemp(join(tmpdir(), "fleet-from-"));
    const runs = await mkdtemp(join(tmpdir(), "fleet-runs-"));
    await writeFile(join(from, "one.json"), JSON.stringify({ a: 1 }));
    await writeFile(join(from, "two.json.gz"), gzipSync(JSON.stringify({ b: 2 })));
    await writeFile(join(from, "half.json"), '{"a": ');
    expect(await importRuns(from, "lab", runs)).toBe(2);
    expect((await readdir(runs)).sort()).toEqual(["lab--one.json", "lab--two.json"]);
    expect(JSON.parse(await readFile(join(runs, "lab--two.json"), "utf8"))).toEqual({ b: 2 });
    expect(await importRuns(from, "lab", runs)).toBe(0);
  });
});
