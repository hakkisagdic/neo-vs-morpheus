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
    // Weaken takes 750 ms and Harm 1000 ms, plus 100 ms to target, and both hit at once; Magic
    // Arrow takes 750 ms and then flies for 1.25 s under AOS rules: 2.1 s in all (composite-4).
    expect(interrupts(snapshot({ casting: "flamestrike", landsInMs: 2200 }))).toEqual([
      "interrupt:harm", "interrupt:weaken", "interrupt:magicArrow",
    ]);
    expect(interrupts(snapshot({ casting: "explosion", landsInMs: 1600 }))).toEqual(["interrupt:harm", "interrupt:weaken"]);
    expect(interrupts(snapshot({ casting: "explosion", landsInMs: 900 }))).toEqual(["interrupt:weaken"]);
    expect(interrupts(snapshot({ casting: "magicArrow", landsInMs: 250 }))).toEqual([]);
    expect(interrupts(snapshot({ casting: null }))).toEqual([]);
  });

  it("counts our own recovery before we can cast", () => {
    expect(landsFirst("weaken", snapshot({ casting: "explosion", landsInMs: 1200 }))).toBe(true);
    expect(landsFirst("weaken", snapshot({ casting: "explosion", landsInMs: 1200, readyInMs: 500 }))).toBe(false);
    // Magic Arrow's flight counts too.
    expect(landsFirst("magicArrow", snapshot({ casting: "explosion", landsInMs: 1200 }))).toBe(false);
  });

  it("does not interrupt too late even when the answer asks for it", () => {
    const overrides: string[] = [];
    // A heal of theirs breaks nothing of ours, so the Explosion is fine; only the interrupt is late.
    const { plan } = resolvePlan(
      snapshot({ casting: "greaterHeal", landsInMs: 250 }),
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
    expect(overrides.join(" ")).toMatch(/before (Magic Arrow|Harm|Weaken) could/);
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
    const s = snapshot({ casting: "greaterHeal", landsInMs: 250 });
    const out = convertLabel(label(s, { "interrupt:magicArrow": 0.6, "damage:explosion": 0.3, "defense:heal": 0.1 }, describeDuel(s)), s);
    if (typeof out === "string") throw new Error(out);
    expect(out.teacher.probabilities["interrupt:magicArrow"]).toBeUndefined();
    expect(out.teacher.probabilities["damage:explosion"]).toBeCloseTo(0.75);
    expect(out.teacher.converted).toEqual({ from: "composite-1", kept: 0.4 });
    expect(out.format.question).toBe("composite-4");
  });

  it("turns attacks out of reach into chasing, and drops interrupts that could not reach", async () => {
    const { describeDuel } = await import("../src/brain/duel-policy.ts");
    const s = snapshot({ distance: 13, hits: 40 });
    const out = convertLabel(label(s, { "damage:explosion": 0.5, "interrupt:magicArrow": 0.2, "defense:greaterHeal": 0.3 }, describeDuel(s)), s);
    if (typeof out === "string") throw new Error(out);
    expect(out.teacher.probabilities["damage:chase"]).toBeCloseTo(0.5 / 0.8);
    expect(out.teacher.probabilities["defense:greaterHeal"]).toBeCloseTo(0.3 / 0.8);
  });

  it("never offers an option the teacher did not see", async () => {
    const { describeDuel } = await import("../src/brain/duel-policy.ts");
    const s = snapshot({});
    const seen = { "damage:explosion": 0.5, "damage:magicArrow": 0.3, "defense:greaterHeal": 0.2 };
    const out = convertLabel({ ...label(s, seen, describeDuel(s)), format: { describe: "duel-1", question: "composite-2" } } as never, s);
    if (typeof out === "string") throw new Error(out);
    expect(Object.keys(out.questions.move.criteria).sort()).toEqual(Object.keys(seen).sort());
    expect(out.teacher.probabilities["damage:energyBolt"]).toBeUndefined();
  });

  it("refuses a label whose snapshot no longer renders to its text", () => {
    const s = snapshot();
    expect(convertLabel(label(s, { "damage:explosion": 1 }, "something else"), s)).toMatch(/no longer renders/);
  });
});

describe("casts their spell would break (composite-3)", () => {
  it("drops casts that would still be going when their damage lands", () => {
    // Their Lightning hits as it lands, in 1.9 s: Explosion (2.0 s) would be broken, Lightning (1.5 s) would not.
    const options = legalOptions(snapshot({ casting: "lightning", landsInMs: 1_900 }));
    expect(options).not.toContain("damage:explosion");
    expect(options).toContain("damage:lightning");
    expect(options).toContain("defense:hold");
    // Their Flamestrike flies 1.25 s more (AOS rules): at 3.15 s it breaks nothing of a 2 s Explosion.
    expect(legalOptions(snapshot({ casting: "flamestrike", landsInMs: 1_900 }))).toContain("damage:explosion");
  });

  it("counts Explosion's three seconds before its damage lands", () => {
    const options = legalOptions(snapshot({ casting: "explosion", landsInMs: 500 }));
    expect(options).toContain("damage:flamestrike");
    expect(options).toContain("defense:greaterHeal");
    expect(options).not.toContain("defense:hold");
  });

  it("offers only waiting (or dodging) when every cast would be broken", () => {
    // Harm hits as it lands, in 250 ms: anything cast now would be broken.
    const s = snapshot({ hits: 95, casting: "harm", landsInMs: 250 });
    expect(legalOptions(s)).toEqual(["defense:hold"]);
    // One running step (about 200 ms) reaches cover before they aim in 250 ms; two do not.
    expect(legalOptions({ ...s, us: { ...s.us, coverSteps: 1 } })).toEqual(["defense:hold", "defense:dodge"]);
    expect(legalOptions({ ...s, us: { ...s.us, coverSteps: 2 } })).toEqual(["defense:hold"]);
    const slow = snapshot({ casting: "explosion", landsInMs: 1_500 });
    expect(legalOptions({ ...slow, us: { ...slow.us, coverSteps: 2 } })).toContain("defense:dodge");
    expect(legalOptions({ ...slow, us: { ...slow.us, coverSteps: 9 } })).not.toContain("defense:dodge");
  });

  it("waits until their spell has landed, then decides again", () => {
    const hold = (casting: string) =>
      resolvePlan(
        snapshot({ casting, landsInMs: 250 }),
        { choice: "defense", probabilities: { defense: 1, damage: 0, interrupt: 0 } },
        { damage: { choice: "", probabilities: {} }, interrupt: { choice: "", probabilities: {} }, defense: { choice: "hold", probabilities: { hold: 1 } } },
        undefined,
        [],
      ).plan;
    expect(hold("harm")).toEqual({ kind: "wait", ms: 350, hold: true });
    // A Magic Arrow hits 1.25 s after it lands.
    expect(hold("magicArrow")).toEqual({ kind: "wait", ms: 1_600, hold: true });
  });
});
