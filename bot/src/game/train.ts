// Skill training ("kasma"): Magery at the circle with the best gain odds, Meditation whenever mana
// runs low, Eval Int in idle moments, and Resisting Spells when a partner casts on us.
//
// ModernUO (AOS rules): a spell of circle c succeeds with chance (skill - min) / 40 where
// min = (c - 1) * 100 / 7 - 20, and gains are likeliest around a 50% chance.
import { EventEmitter } from "node:events";
import * as out from "../uo/outgoing.ts";
import { type Spell, spell } from "../uo/spells.ts";
import { Caster } from "./caster.ts";
import type { Session } from "./session.ts";

export const SKILL = { magery: 25, evalInt: 16, magicResist: 26, meditation: 46 } as const;
const SKILL_NAMES: Record<number, string> = { 25: "Magery", 16: "Eval Int", 26: "Resist", 46: "Meditation" };

/** Harmless practice spell for each circle (self or ground targeted). */
const PRACTICE: Record<number, string> = {
  1: "nightSight",
  2: "protection",
  3: "bless",
  4: "greaterHeal",
  5: "magicReflection",
  6: "invisibility",
  7: "energyField",
  8: "earthquake",
};

/** Harmful but weak spells for a partner, to train their Resisting Spells. */
const ON_PARTNER = ["clumsy", "feeblemind", "weaken"];

export const circleMin = (circle: number) => ((circle - 1) * 100) / 7 - 20;
export const successChance = (skill: number, circle: number) =>
  Math.min(1, Math.max(0, (skill - circleMin(circle)) / 40));

/** The circle whose success chance is closest to 50%. */
export function bestCircle(skill: number): number {
  let best = 1;
  for (let c = 1; c <= 8; c++) {
    if (Math.abs(successChance(skill, c) - 0.5) < Math.abs(successChance(skill, best) - 0.5)) {
      best = c;
    }
  }
  return best;
}

type TrainerEvents = { log: [text: string]; progress: [skills: Record<string, number>] };

export class SkillTrainer extends EventEmitter<TrainerEvents> {
  readonly session: Session;
  readonly caster: Caster;
  partner: number | null = null;
  /** Cast weak curses on the partner to train their Resisting Spells (their casts get disturbed). */
  resist = false;
  #meditating = false;
  #lastEval = 0;
  casts = 0;
  fizzles = 0;

  constructor(session: Session) {
    super();
    this.session = session;
    this.caster = new Caster(session);
  }

  skill(id: number): number {
    return this.session.world.skills.get(id)?.base ?? 0;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(Object.entries(SKILL_NAMES).map(([id, name]) => [name, this.skill(Number(id))]));
  }

  /** Trains until `signal` aborts or Magery reaches `goal`. `restock` refills reagents. */
  async run(signal: AbortSignal, goal: number, restock: () => Promise<void>): Promise<void> {
    const w = this.session.world;
    const onJournal = (e: { cliloc?: number; text: string }) => {
      if (e.cliloc === 501851) {
        this.#meditating = true; // You enter a meditative trance.
      } else if (e.cliloc === 501846 || e.cliloc === 500134) {
        this.#meditating = false; // You are at peace. / You stop meditating.
      }
    };
    w.on("journal", onJournal);
    try {
      while (!signal.aborted && this.skill(SKILL.magery) < goal) {
        await this.#step(restock);
      }
    } finally {
      w.off("journal", onJournal);
    }
  }

  async #step(restock: () => Promise<void>): Promise<void> {
    const w = this.session.world;
    const p = w.player;
    const magery = this.skill(SKILL.magery);
    const circle = bestCircle(magery);
    const practice: Spell = spell(PRACTICE[circle]);

    // Meditate from low mana back to nearly full; Meditation gains on every use.
    if (p.mana < practice.mana + 5 || (this.#meditating && p.mana < p.manaMax * 0.9)) {
      if (!this.#meditating) {
        this.session.client.send(out.useSkill(SKILL.meditation));
      }
      await sleep(this.#meditating ? 1_500 : 2_500);
      if (Date.now() - this.#lastEval > 3_000) {
        await this.#evalSelf(); // idle anyway: practise Eval Int
      }
      return;
    }
    this.#meditating = false;

    const regs = w.reagents();
    if (Object.values(regs).some((n) => n < 5)) {
      this.emit("log", "reagents low; asking the GM for more");
      await restock();
      await sleep(800);
    }

    const wait = this.caster.readyAt - w.now();
    if (wait > 0) {
      await sleep(wait);
    }

    // With a partner, every third cast is a weak curse on them (their Resisting Spells).
    const onPartner = this.resist && this.partner !== null && this.casts % 3 === 2;
    const sp = onPartner ? spell(ON_PARTNER[this.casts % ON_PARTNER.length]) : practice;
    const target =
      onPartner && this.partner !== null
        ? ({ kind: "mobile", serial: this.partner } as const)
        : sp.target === "location"
          ? ({ kind: "location", x: p.x + 2, y: p.y + 2, z: p.z } as const)
          : ({ kind: "self" } as const);
    const outcome = await this.caster.cast(sp, target);
    this.casts++;
    if (outcome.result === "fizzled") {
      this.fizzles++;
    } else if (outcome.result !== "cast") {
      this.emit("log", `${sp.name}: ${outcome.result}`);
      if (outcome.result === "noReagents") {
        await restock();
      }
      await sleep(500);
    }
  }

  async #evalSelf(): Promise<void> {
    const { client, world } = this.session;
    this.#lastEval = Date.now();
    const cursor = new Promise<number | null>((resolve) => {
      const t = setTimeout(() => {
        world.off("target", onTarget);
        resolve(null);
      }, 2_000);
      const onTarget = (c: { id: number }) => {
        clearTimeout(t);
        world.off("target", onTarget);
        resolve(c.id);
      };
      world.on("target", onTarget);
    });
    client.send(out.useSkill(SKILL.evalInt));
    const id = await cursor;
    if (id !== null) {
      const self = this.partner ?? world.playerSerial; // evaluating someone else works better
      const m = world.mobile(self);
      client.send(out.targetObject(id, 0, self, m.x, m.y, m.z, m.body));
      world.target = null;
      this.#meditating = false; // using a skill breaks the trance
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

