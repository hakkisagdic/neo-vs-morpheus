import { describe, expect, it } from "vitest";
import { RuleBrain } from "../src/brain/brains.ts";
import { makeBrain, parseBrain } from "../src/game/match.ts";

describe("parseBrain", () => {
  it("reads the plain brains", () => {
    expect(parseBrain("laya")).toEqual({ brain: "laya" });
    expect(parseBrain("jev")).toEqual({ brain: "jev" });
    expect(parseBrain("rules")).toEqual({ brain: "rules" });
  });

  it("gives the scripted bot its own reaction time", () => {
    expect(parseBrain("rules@250")).toEqual({ brain: "rules", reactionMs: 250 });
    expect(parseBrain("rules@0")).toEqual({ brain: "rules", reactionMs: 0 });
  });

  it("refuses anything else", () => {
    for (const spec of ["", "human", "laya@100", "rules@", "rules@-5", "rules@1.5", "rules@abc", "rules@6000", "rules@1@2"]) {
      expect(parseBrain(spec), spec).toBeNull();
    }
  });
});

describe("makeBrain", () => {
  it("passes the reaction time to the scripted bot", () => {
    const brain = makeBrain("rules", "mage", 250);
    expect(brain).toBeInstanceOf(RuleBrain);
    expect((brain as RuleBrain).reactionMs).toBe(250);
  });
});
