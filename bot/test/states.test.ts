import { describe, expect, it } from "vitest";
import { sampledMovementStates } from "../src/distill/states.ts";

describe("movement batch", () => {
  const states = sampledMovementStates(200);

  it("is the same batch every time for a seed", () => {
    expect(sampledMovementStates(200)).toEqual(states);
    expect(sampledMovementStates(200, 7)).not.toEqual(states);
  });

  it("puts the opponent out of sight or out of spell range", () => {
    for (const s of states) {
      expect(s.state).toMatch(/out of sight|out of spell range/);
      expect(s.module).toBe("mage");
    }
    const hidden = states.filter((s) => s.state.includes("out of sight")).length;
    expect(hidden).toBeGreaterThan(60);
    expect(hidden).toBeLessThan(140);
  });

  it("still asks the whole composite question", () => {
    const options = Object.keys(states[0].questions.move.criteria);
    expect(options).toContain("defense:greaterHeal");
    expect(options).toContain("defense:retreat");
    expect(options.some((k) => k.startsWith("damage:"))).toBe(true);
  });
});
