import { describe, expect, it } from "vitest";
import { bestCircle, circleMin, successChance } from "../src/game/train.ts";
import {
  RuleTrainBrain,
  type TrainState,
  actionOf,
  describeTraining,
  makeTrainBrain,
  manaPerSecond,
  trainOptions,
  tranceChance,
} from "../src/game/train-brain.ts";

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

const state = (over: Partial<TrainState> = {}): TrainState => ({
  magery: 50,
  meditation: 50,
  evalInt: 50,
  int: 100,
  mana: 100,
  manaMax: 100,
  meditating: false,
  skillReadyIn: 0,
  casts: 0,
  fizzles: 0,
  gained: 0,
  seconds: 0,
  ...over,
});

describe("training decisions", () => {
  it("knows ModernUO's trance odds and mana regeneration", () => {
    expect(tranceChance(50, 50)).toBeCloseTo(0.5);
    expect(tranceChance(50, 80)).toBe(0); // too little mana left at Meditation 50: no trance at all
    expect(tranceChance(50, 10)).toBe(1);
    // Int 100, Meditation 50: 6 points, 12 in a trance -> 0.8 and 1.4 mana a second
    expect(manaPerSecond(100, 50, false)).toBeCloseTo(0.8);
    expect(manaPerSecond(100, 50, true)).toBeCloseTo(1.4);
  });

  it("offers the circles that can gain and that mana allows, and says what each costs", () => {
    const options = trainOptions(state({ mana: 12 }));
    expect(Object.keys(options)).toEqual(["cast:1", "cast:2", "cast:3", "cast:4", "meditate", "evalInt"]); // 5th costs 14
    expect(options["cast:4"]).toBe("Cast Greater Heal (circle 4, 11 mana): about 68% to succeed");
    expect(options.meditate).toMatch(/^Meditate: about 0% to enter a trance/);
    expect(trainOptions(state())).not.toHaveProperty("meditate"); // full mana
    expect(trainOptions(state({ mana: 60, skillReadyIn: 6.2 })).meditate).toBe("Rest until skills can be used (7 s), then meditate");
    expect(describeTraining(state({ mana: 60, meditating: true }))).toContain("Mana 60 of 100, in a meditative trance.");
  });

  it("scripts a trainer that casts near even odds and meditates while a trance is still likely", async () => {
    const rules = new RuleTrainBrain();
    expect((await rules.decide(state())).key).toBe("cast:4");
    expect((await rules.decide(state({ mana: 50 }))).key).toBe("meditate"); // an even chance of a trance
    expect((await rules.decide(state({ mana: 60 }))).key).toBe("cast:4");
    expect((await rules.decide(state({ mana: 85, meditating: true }))).key).toBe("meditate");
    expect((await rules.decide(state({ mana: 92, meditating: true }))).key).toBe("cast:4");
    expect((await rules.decide(state({ magery: 60 }))).key).toBe("cast:5");
    expect(actionOf("cast:5")).toEqual({ kind: "cast", circle: 5 });
  });

  it("lets a random pick choose among the options only", async () => {
    const brain = makeTrainBrain("random");
    const s = state({ mana: 12 });
    for (let k = 0; k < 20; k++) {
      const choice = await brain.decide(s);
      expect(Object.keys(trainOptions(s))).toContain(choice.key);
      expect(choice.model).toBe("random");
    }
  });
});
