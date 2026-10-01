import { describe, expect, it } from "vitest";
import { exploration } from "../src/brain/brains.ts";
import type { Decision, DuelSnapshot } from "../src/brain/types.ts";
import { takenKey } from "../src/distill/outcomes.ts";

const answer = { choice: "interrupt:magicArrow", probabilities: { "interrupt:magicArrow": 0.8, "damage:explosion": 0.15, "defense:cure": 0.05 } };
const rolls = (...xs: number[]) => () => xs.shift() ?? 0;

describe("exploration", () => {
  it("tries another legal option in the given share of decisions", () => {
    expect(exploration(answer, 0.25, rolls(0.1, 0.0))).toBe("damage:explosion");
    expect(exploration(answer, 0.25, rolls(0.1, 0.99))).toBe("defense:cure");
    expect(exploration(answer, 0.25, rolls(0.3))).toBeUndefined();
  });

  it("never explores when off, or with a single option", () => {
    expect(exploration(answer, 0, rolls(0))).toBeUndefined();
    expect(exploration({ choice: "damage:chase", probabilities: { "damage:chase": 1 } }, 1, rolls(0))).toBeUndefined();
  });

  it("names the move tried, not the model's choice, when outcomes are scored", () => {
    const d = {
      module: "mage", mode: { choice: "interrupt", probabilities: {} }, explored: "damage:explosion",
      plan: { kind: "cast", spell: "explosion", target: "them" },
    } as unknown as Decision;
    expect(takenKey(d, {} as DuelSnapshot)).toBe("damage:explosion");
  });
});
