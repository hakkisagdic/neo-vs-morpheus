import { describe, expect, it } from "vitest";
import { compositeQuestion, landsFirst, legalOptions, resolvePlan } from "../src/brain/duel-policy.ts";
import type { DuelSnapshot } from "../src/brain/types.ts";
import { convertLabel } from "../src/distill/convert.ts";
import type { LabeledState } from "../src/distill/label.ts";

type Over = {
  hits?: number;
  mana?: number;
  poisoned?: boolean;
  casting?: string | null;
  landsInMs?: number;
  readyInMs?: number;
  distance?: number;
  inLineOfSight?: boolean;
};

const snapshot = (o: Over = {}): DuelSnapshot => {
  const distance = o.distance ?? 5;
  return {
    now: 0,
    us: {
      name: "Neo", serial: 1, hits: o.hits ?? 60, hitsMax: 100, mana: o.mana ?? 100, manaMax: 100, stam: 50, stamMax: 50,
      poisoned: o.poisoned ?? false, x: 0, y: 0, z: 0, readyInMs: o.readyInMs ?? 0, lastSpell: null, lastSpellAgoMs: 0,
    },
    them: {
      name: "Morpheus", serial: 2, healthPct: 50, poisoned: false, x: distance, y: 0, z: 0, dead: false,
      casting: o.casting ?? null, castingForMs: 0, landsInMs: o.landsInMs ?? 0, distance,
      inLineOfSight: o.inLineOfSight ?? true, inRange: distance <= 10,
    },
    reagents: { blackPearl: 9, bloodmoss: 9, garlic: 9, ginseng: 9, mandrakeRoot: 9, nightshade: 9, sulfurousAsh: 9, spidersSilk: 9 },
    tiles: [],
    recent: [],
  };
};

const interrupts = (s: DuelSnapshot) => legalOptions(s).filter((k) => k.startsWith("interrupt:"));

describe("interrupt timing", () => {
  it("offers an interrupt only when it would land while their spell is still being cast", () => {
    // Magic Arrow and Weaken take 750 ms, Harm 1000 ms, plus 100 ms to target.
    expect(interrupts(snapshot({ casting: "explosion", landsInMs: 1600 }))).toEqual([
      "interrupt:harm", "interrupt:weaken", "interrupt:magicArrow",
    ]);
    expect(interrupts(snapshot({ casting: "explosion", landsInMs: 900 }))).toEqual(["interrupt:weaken", "interrupt:magicArrow"]);
    expect(interrupts(snapshot({ casting: "magicArrow", landsInMs: 250 }))).toEqual([]);
    expect(interrupts(snapshot({ casting: null }))).toEqual([]);
  });

  it("counts our own recovery before we can cast", () => {
    expect(landsFirst("magicArrow", snapshot({ casting: "explosion", landsInMs: 1200 }))).toBe(true);
    expect(landsFirst("magicArrow", snapshot({ casting: "explosion", landsInMs: 1200, readyInMs: 500 }))).toBe(false);
  });

  it("does not interrupt too late even when the answer asks for it", () => {
    const overrides: string[] = [];
    const { plan } = resolvePlan(
      snapshot({ casting: "magicArrow", landsInMs: 250 }),
      { choice: "interrupt", probabilities: { interrupt: 0.8, damage: 0.2, defense: 0 } },
      {
        damage: { choice: "explosion", probabilities: { explosion: 1 } },
        interrupt: { choice: "magicArrow", probabilities: { magicArrow: 1 } },
        defense: { choice: "heal", probabilities: { heal: 1 } },
      },
      undefined,
      overrides,
    );
    expect(plan).toEqual({ kind: "cast", spell: "explosion", target: "them" });
    expect(overrides.join(" ")).toMatch(/before Magic Arrow could/);
  });
});

describe("legal options only", () => {
  it("out of reach offers chasing and moves on yourself, no spells at them", () => {
    const far = legalOptions(snapshot({ distance: 13, hits: 40, poisoned: true }));
    expect(far).toContain("damage:chase");
    expect(far).toContain("defense:greaterHeal");
    expect(far).toContain("defense:cure");
    expect(far.some((k) => k.startsWith("interrupt:") || (k.startsWith("damage:") && k !== "damage:chase"))).toBe(false);
    expect(legalOptions(snapshot({ inLineOfSight: false }))).toContain("damage:chase");
  });

  it("in reach offers no chase and no cure unless poisoned", () => {
    const near = legalOptions(snapshot());
    expect(near).not.toContain("damage:chase");
    expect(near).not.toContain("defense:cure");
    expect(near).toContain("damage:explosion");
  });

  it("asks what to do rather than which spell, with the legal options only", () => {
    const q = compositeQuestion(snapshot({ distance: 13 })).move;
    expect(q.instructions).toBe("What should Neo do next?");
    expect(Object.keys(q.criteria)).toEqual(legalOptions(snapshot({ distance: 13 })));
    expect(q.criteria["damage:chase"]).toMatch(/until they are in range and in sight/);
  });
});

describe("carrying labels over to the new question", () => {
  const label = (s: DuelSnapshot, probabilities: Record<string, number>, state: string): LabeledState =>
    ({ id: "run:x.json:0", source: "run", state, questions: {}, teacher: { model: "jev", probabilities, inputTokens: 1 } }) as unknown as LabeledState;

  it("drops an interrupt that could not land and renormalises the rest", async () => {
    const { describeDuel } = await import("../src/brain/duel-policy.ts");
    const s = snapshot({ casting: "magicArrow", landsInMs: 250 });
    const out = convertLabel(label(s, { "interrupt:magicArrow": 0.6, "damage:explosion": 0.3, "defense:heal": 0.1 }, describeDuel(s)), s);
    if (typeof out === "string") throw new Error(out);
    expect(out.teacher.probabilities["interrupt:magicArrow"]).toBeUndefined();
    expect(out.teacher.probabilities["damage:explosion"]).toBeCloseTo(0.75);
    expect(out.teacher.converted).toEqual({ from: "composite-1", kept: 0.4 });
    expect(out.format.question).toBe("composite-2");
  });

  it("turns attacks out of reach into chasing, and drops interrupts that could not reach", async () => {
    const { describeDuel } = await import("../src/brain/duel-policy.ts");
    const s = snapshot({ distance: 13, hits: 40 });
    const out = convertLabel(label(s, { "damage:explosion": 0.5, "interrupt:magicArrow": 0.2, "defense:greaterHeal": 0.3 }, describeDuel(s)), s);
    if (typeof out === "string") throw new Error(out);
    expect(out.teacher.probabilities["damage:chase"]).toBeCloseTo(0.5 / 0.8);
    expect(out.teacher.probabilities["defense:greaterHeal"]).toBeCloseTo(0.3 / 0.8);
  });

  it("refuses a label whose snapshot no longer renders to its text", () => {
    const s = snapshot();
    expect(convertLabel(label(s, { "damage:explosion": 1 }, "something else"), s)).toMatch(/no longer renders/);
  });
});
