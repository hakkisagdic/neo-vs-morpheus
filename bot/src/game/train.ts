// Skill training ("kasma"): at every step a brain (./train-brain.ts: the scripted trainer, a model,
// or a random pick) chooses a practice spell of some circle, meditation, or Eval Int, and the
// trainer carries it out and keeps the step. With a partner, every third cast is a weak curse on
// them, which trains their Resisting Spells.
import { EventEmitter } from "node:events";
import * as out from "../uo/outgoing.ts";
import { spell } from "../uo/spells.ts";
import { Caster } from "./caster.ts";
import type { Session } from "./session.ts";
import { PRACTICE, RuleTrainBrain, type TrainBrain, type TrainChoice, type TrainState, actionOf } from "./train-brain.ts";

export { PRACTICE, bestCircle, circleMin, successChance } from "./train-brain.ts";

export const SKILL = { magery: 25, evalInt: 16, magicResist: 26, meditation: 46 } as const;
const SKILL_NAMES: Record<number, string> = { 25: "Magery", 16: "Eval Int", 26: "Resist", 46: "Meditation" };

/** How long a skill keeps the next one waiting (ModernUO): Meditation 10 s, Eval Int 1 s. */
const SKILL_DELAY_MS: Record<number, number> = { [SKILL.meditation]: 10_000, [SKILL.evalInt]: 1_000 };

/** Failed decisions in a row after which a session stops: its backend is down, not slow. */
const MAX_FAILING = 30;

/** Harmful but weak spells for a partner, to train their Resisting Spells. */
const ON_PARTNER = ["clumsy", "feeblemind", "weaken"];

/** One step: the state the brain saw, its choice, and how a cast or a meditation went. */
export type TrainStep = { state: TrainState; choice: TrainChoice; outcome?: string };

type TrainerEvents = { log: [text: string] };

export class SkillTrainer extends EventEmitter<TrainerEvents> {
  readonly session: Session;
  readonly caster: Caster;
  readonly brain: TrainBrain;
  partner: number | null = null;
  /** Cast weak curses on the partner to train their Resisting Spells (their casts get disturbed). */
  resist = false;
  readonly steps: TrainStep[] = [];
  /** Magery as it rose: [seconds since the start, Magery]. */
  readonly progress: [number, number][] = [];
  casts = 0;
  fizzles = 0;
  /** Times the reagents ran low and the GM restocked them (a prep, which fills mana too). */
  restocks = 0;
  /** Steps the brain could not decide (its backend failed); the time they took is lost. */
  errors = 0;
  #meditating = false;
  #skillReadyAt = 0;
  #startedAt = Date.now();
  #startMagery = 0;

  /** The scripted trainer by default, practising Eval Int while it waits for mana. */
  constructor(session: Session, brain: TrainBrain = new RuleTrainBrain(undefined, true)) {
    super();
    this.session = session;
    this.caster = new Caster(session);
    this.brain = brain;
  }

  skill(id: number): number {
    return this.session.world.skills.get(id)?.base ?? 0;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(Object.entries(SKILL_NAMES).map(([id, name]) => [name, this.skill(Number(id))]));
  }

  seconds(): number {
    return (Date.now() - this.#startedAt) / 1000;
  }

  state(): TrainState {
    const { player: p, stats } = this.session.world;
    const magery = this.skill(SKILL.magery);
    return {
      magery,
      meditation: this.skill(SKILL.meditation),
      evalInt: this.skill(SKILL.evalInt),
      int: stats.int,
      mana: p.mana,
      manaMax: p.manaMax,
      meditating: this.#meditating,
      skillReadyIn: Math.max(0, (this.#skillReadyAt - Date.now()) / 1000),
      casts: this.casts,
      fizzles: this.fizzles,
      gained: Math.round((magery - this.#startMagery) * 10) / 10,
      seconds: Math.round(this.seconds() * 10) / 10,
    };
  }

  /** Trains until `signal` aborts or `done` says the session is over. `restock` refills reagents. */
  async run(signal: AbortSignal, done: (s: TrainState) => boolean, restock: () => Promise<void>): Promise<void> {
    const w = this.session.world;
    this.#startedAt = Date.now();
    this.#startMagery = this.skill(SKILL.magery);
    const onJournal = (e: { cliloc?: number; text: string }) => {
      if (e.cliloc === 501851) {
        this.#meditating = true; // You enter a meditative trance.
      } else if (e.cliloc === 501846 || e.cliloc === 500134 || e.cliloc === 501850) {
        this.#meditating = false; // You are at peace. / You stop meditating. / You cannot focus your concentration.
      } else if (e.cliloc === 500118) {
        this.#skillReadyAt = Math.max(this.#skillReadyAt, Date.now() + 1_000); // You must wait to perform another action.
      }
    };
    const onSkills = () => {
      const magery = this.skill(SKILL.magery);
      if (magery !== (this.progress.at(-1)?.[1] ?? this.#startMagery)) {
        this.progress.push([Math.round(this.seconds()), magery]);
      }
    };
    w.on("journal", onJournal);
    w.on("skills", onSkills);
    let failing = 0;
    try {
      for (let s = this.state(); !signal.aborted && !done(s); s = this.state()) {
        let choice: TrainChoice;
        try {
          choice = await this.brain.decide(s);
          failing = 0;
        } catch (err) {
          this.errors++;
          this.emit("log", `${this.brain.name}: ${(err as Error).message}`);
          if (++failing >= MAX_FAILING) {
            this.emit("log", `${this.brain.name} failed ${failing} times in a row; training stopped`);
            break;
          }
          await sleep(1_000);
          continue;
        }
        const step: TrainStep = { state: s, choice };
        this.steps.push(step);
        step.outcome = await this.#act(choice.key, restock);
      }
    } finally {
      w.off("journal", onJournal);
      w.off("skills", onSkills);
    }
  }

  async #act(key: string, restock: () => Promise<void>): Promise<string | undefined> {
    const action = actionOf(key);
    if (action.kind === "meditate") {
      if (this.#meditating) {
        await sleep(1_500);
        return undefined;
      }
      await this.#skillReady();
      this.#useSkill(SKILL.meditation);
      await sleep(1_000); // the trance, or none, is in the journal by then
      return this.#meditating ? "trance" : "no trance";
    }
    if (action.kind === "evalInt") {
      await this.#skillReady();
      await this.#evalSelf();
      return undefined;
    }

    const w = this.session.world;
    const p = w.player;
    this.#meditating = false; // a cast ends the trance
    if (Object.values(w.reagents()).some((n) => n < 5)) {
      this.emit("log", "reagents low; asking the GM for more");
      this.restocks++;
      await restock();
      await sleep(800);
    }
    const wait = this.caster.readyAt - w.now();
    if (wait > 0) {
      await sleep(wait);
    }
    // With a partner, every third cast is a weak curse on them (their Resisting Spells).
    const onPartner = this.resist && this.partner !== null && this.casts % 3 === 2;
    const sp = onPartner ? spell(ON_PARTNER[this.casts % ON_PARTNER.length]) : spell(PRACTICE[action.circle]);
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
        this.restocks++;
        await restock();
      }
      await sleep(500);
    }
    return outcome.result;
  }

  #useSkill(id: number): void {
    this.session.client.send(out.useSkill(id));
    this.#skillReadyAt = Date.now() + (SKILL_DELAY_MS[id] ?? 1_000);
  }

  async #skillReady(): Promise<void> {
    const wait = this.#skillReadyAt - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
  }

  async #evalSelf(): Promise<void> {
    const { world } = this.session;
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
    this.#useSkill(SKILL.evalInt);
    const id = await cursor;
    if (id !== null) {
      const self = this.partner ?? world.playerSerial; // evaluating someone else works better
      const m = world.mobile(self);
      this.session.client.send(out.targetObject(id, 0, self, m.x, m.y, m.z, m.body));
      world.target = null;
      this.#meditating = false; // using a skill breaks the trance
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
