import { describe, expect, it } from "vitest";
import { bootstrapDifference, bootstrapInterval, holm, share, wilson } from "../src/bench/stats.ts";

const runs = (shares: number[], rounds = 10) => shares.map((s) => ({ points: s * rounds, rounds }));

describe("bench statistics", () => {
  it("scores a share of points and gives Wilson's interval for independent rounds", () => {
    expect(share(runs([0.6, 0.8]))).toBeCloseTo(0.7);
    const [lo, hi] = wilson(70, 100);
    expect(lo).toBeCloseTo(0.604, 2);
    expect(hi).toBeCloseTo(0.781, 2);
  });

  it("gives a wider interval when runs disagree, since rounds of a run go together", () => {
    const even = runs(Array.from({ length: 40 }, () => 0.6));
    const split = runs(Array.from({ length: 40 }, (_, i) => (i % 2 ? 1 : 0.2)));
    const [a, b] = bootstrapInterval(even);
    const [c, d] = bootstrapInterval(split);
    expect(b - a).toBeLessThan(0.001);
    expect(d - c).toBeGreaterThan(0.15);
    expect(bootstrapInterval(split)).toEqual([c, d]); // seeded: the same every time
  });

  it("tells a real difference from noise", () => {
    const strong = runs(Array.from({ length: 60 }, (_, i) => 0.7 + (i % 3) * 0.05));
    const weak = runs(Array.from({ length: 60 }, (_, i) => 0.5 + (i % 3) * 0.05));
    const real = bootstrapDifference(strong, weak);
    expect(real.difference).toBeCloseTo(0.2);
    expect(real.p).toBeLessThan(0.01);
    expect(real.interval[0]).toBeGreaterThan(0);
    const noise = bootstrapDifference(weak, runs(Array.from({ length: 60 }, (_, i) => 0.5 + ((i + 1) % 3) * 0.05)));
    expect(noise.p).toBeGreaterThan(0.05);
  });

  it("adjusts a family of p-values the Holm way", () => {
    expect(holm([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
  });
});
