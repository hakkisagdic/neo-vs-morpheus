import { describe, expect, it } from "vitest";
import { creatureFor, danger, level } from "../src/brain/bestiary.ts";

// lab/bestiary.py's young swordsman (templates/warrior-novice.json, a viking sword).
const novice = { hits: 85, weapon: 50, tactics: 50, anatomy: 50, parry: 30, damage: 16, swing: 3.75 };

describe("bestiary", () => {
  it("finds creatures by name, else by body", () => {
    expect(creatureFor("a timber wolf")?.type).toBe("TimberWolf");
    expect(creatureFor("Some Named Orc", 17)).not.toBeNull();
    expect(creatureFor("nobody we know")).toBeNull();
  });

  it("ranks the danger as lab/bestiary.py does", () => {
    const losses = ["a rat", "a timber wolf", "a harpy", "a lich"].map((n) => {
      const c = creatureFor(n);
      if (!c) {
        throw new Error(`${n} is not in the bestiary`);
      }
      return danger(c, novice).loss;
    });
    expect(losses).toEqual([...losses].sort((a, b) => a - b));
    // The same numbers as the Python model (python3 lab/bestiary.py --show "timber wolf").
    expect(danger(creatureFor("a timber wolf") as NonNullable<ReturnType<typeof creatureFor>>, novice)).toEqual({ seconds: 14.9, loss: 0.28, level: "low" });
    expect([0.1, 0.5, 1, 2].map(level)).toEqual(["low", "medium", "high", "deadly"]);
  });
});
