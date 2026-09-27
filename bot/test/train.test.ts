import { describe, expect, it } from "vitest";
import { bestCircle, circleMin, successChance } from "../src/game/train.ts";

describe("skill training", () => {
  it("uses ModernUO's AOS magery difficulty", () => {
    expect(circleMin(1)).toBeCloseTo(-20);
    expect(circleMin(8)).toBeCloseTo(80);
    expect(successChance(100, 8)).toBeCloseTo(0.5);
    expect(successChance(30, 1)).toBe(1);
  });

  it("practises the circle closest to a coin flip", () => {
    expect(bestCircle(50)).toBe(4); // 4th: 68%, 5th: 32% -> first tie wins
    expect(bestCircle(65)).toBe(6);
    expect(bestCircle(100)).toBe(8);
    for (let skill = 30; skill <= 100; skill += 5) {
      expect(Math.abs(successChance(skill, bestCircle(skill)) - 0.5)).toBeLessThanOrEqual(0.25);
    }
  });
});
