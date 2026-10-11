import { describe, expect, it } from "vitest";
import { type Pairing, bradleyTerry, ratings } from "../src/bench/ladder.ts";

const runs = (a: string, b: string, aPoints: number, bPoints: number, n: number): Pairing[] =>
  Array.from({ length: n }, () => ({ a, b, aPoints, bPoints }));

describe("UO Bench ratings", () => {
  it("puts a side that takes 75% of the points about 190 Elo above its opponent", () => {
    // 75% overall, run to run between 60% and 90% (identical runs would collapse the bootstrap to a point)
    const r = ratings([...runs("model", "rules@40 mage", 6, 4, 30), ...runs("model", "rules@40 mage", 9, 1, 30)], "rules@40 mage");
    const model = r.find((x) => x.player === "model");
    expect(r.find((x) => x.player === "rules@40 mage")?.rating).toBeCloseTo(1000, 6);
    expect(model?.rating).toBeGreaterThan(1170); // 400 log10(3) = 191, a little less with the prior
    expect(model?.rating).toBeLessThan(1195);
    expect(model?.interval[0]).toBeLessThan(model?.rating ?? 0);
    expect(model?.interval[1]).toBeGreaterThan(model?.rating ?? 0);
  });

  it("chains sides that never met through a common opponent", () => {
    const r = ratings([...runs("A", "bot", 7.5, 2.5, 40), ...runs("B", "bot", 5, 5, 40)], "bot");
    const A = r.find((x) => x.player === "A")?.rating ?? 0;
    const B = r.find((x) => x.player === "B")?.rating ?? 0;
    expect(B).toBeCloseTo(1000, 0);
    expect(A - B).toBeGreaterThan(170);
    expect(r[0].player).toBe("A");
  });

  it("gives a side that never won a finite strength", () => {
    const s = bradleyTerry(runs("loser", "winner", 0, 10, 10));
    expect(Number.isFinite(Math.log(s.get("loser") ?? 0))).toBe(true);
    expect((s.get("winner") ?? 0) > (s.get("loser") ?? 0)).toBe(true);
  });
});
