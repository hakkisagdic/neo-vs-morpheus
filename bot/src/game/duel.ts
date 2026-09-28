// One bot's side of a duel: observe, ask the brain, act, repeat until someone dies.
import { EventEmitter } from "node:events";
import { SPELL_RANGE, teleportTiles } from "../brain/duel-policy.ts";
import type { Decision, DuelBrain, DuelSnapshot } from "../brain/types.ts";
import { CLILOC } from "../uo/cliloc.ts";
import * as out from "../uo/outgoing.ts";
import { spell } from "../uo/spells.ts";
import { type CastOutcome, Caster, castDelayMs } from "./caster.ts";
import { Grid } from "../world/grid.ts";
import { OBSTACLE_GRAPHICS } from "./arena.ts";
import { Mover, chebyshev } from "./mover.ts";
import type { Session } from "./session.ts";

export type DecisionRecord = {
  id: number;
  at: number;
  bot: string;
  opponent: string;
  decision: Decision;
  snapshot: DuelSnapshot;
  outcome?: { result: string; castMs?: number };
};

export type DuelEnd = { winner: string | null; loser: string | null; reason: "death" | "aborted" };

type DuelEvents = {
  decision: [record: DecisionRecord];
  outcome: [record: DecisionRecord];
  log: [text: string];
  end: [end: DuelEnd];
};

/** After a move that got nowhere (too tired, walled in), wait before deciding again. */
const BLOCKED_PAUSE_MS = 400;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

export class DuelController extends EventEmitter<DuelEvents> {
  readonly session: Session;
  readonly brain: DuelBrain;
  readonly opponent: number;
  readonly opponentName: string;
  readonly caster: Caster;
  readonly mover: Mover;
  readonly records: DecisionRecord[] = [];
  #recent: string[] = [];
  #latencyEma = 250;
  #lastSpell: { key: string; at: number } | null = null;

  constructor(session: Session, brain: DuelBrain, opponent: number, opponentName: string) {
    super();
    this.session = session;
    this.brain = brain;
    this.opponent = opponent;
    this.opponentName = opponentName;
    this.caster = new Caster(session);
    this.mover = new Mover(session);
  }

  get name(): string {
    return this.session.name;
  }

  #note(text: string): void {
    this.#recent.push(text);
    if (this.#recent.length > 8) {
      this.#recent.shift();
    }
    this.emit("log", text);
  }

  /** The arena's walkable tiles as the client last saw them. */
  grid(): Grid {
    return new Grid(this.session.world.blockingTiles(OBSTACLE_GRAPHICS));
  }

  snapshot(): DuelSnapshot {
    const w = this.session.world;
    const grid = this.grid();
    const now = w.now();
    const p = w.player;
    const t = w.mobile(this.opponent);
    const casting = t.casting && now - t.casting.since < castDelayMs(t.casting.spell) + 300 ? t.casting : null;
    const distance = chebyshev(p, t);
    const base = {
      us: { x: p.x, y: p.y },
      them: { x: t.x, y: t.y, z: t.z, name: this.opponentName },
    };
    return {
      now,
      us: {
        name: this.name,
        serial: p.serial,
        hits: p.hits,
        hitsMax: p.hitsMax,
        mana: p.mana,
        manaMax: p.manaMax,
        stam: p.stam,
        stamMax: p.stamMax,
        poisoned: p.poison > 0,
        x: p.x,
        y: p.y,
        z: p.z,
        readyInMs: Math.max(0, this.caster.readyAt - now),
        lastSpell: this.#lastSpell ? spell(this.#lastSpell.key).name : null,
        lastSpellAgoMs: this.#lastSpell ? now - this.#lastSpell.at : 0,
      },
      them: {
        name: this.opponentName,
        serial: t.serial,
        healthPct: t.hitsMax > 0 ? Math.round((100 * t.hits) / t.hitsMax) : 100,
        poisoned: t.poison > 0,
        x: t.x,
        y: t.y,
        z: t.z,
        dead: t.dead,
        casting: casting?.spell.key ?? null,
        castingForMs: casting ? now - casting.since : 0,
        landsInMs: casting ? Math.max(0, casting.since + castDelayMs(casting.spell) - now) : 0,
        distance,
        inLineOfSight: grid.lineOfSight(p, t),
        inRange: distance <= SPELL_RANGE,
      },
      reagents: w.reagents(),
      tiles: distance > 2 ? teleportTiles(base as Pick<DuelSnapshot, "us" | "them">, grid) : [],
      recent: [...this.#recent],
    };
  }

  /** Fights until one side dies or `signal` aborts. */
  async run(signal: AbortSignal): Promise<DuelEnd> {
    const w = this.session.world;
    const onDamage = (serial: number, amount: number) => {
      if (serial === this.opponent) {
        this.#note(`${this.opponentName} took ${amount} damage`);
      } else if (serial === w.playerSerial) {
        this.#note(`${this.name} took ${amount} damage`);
      }
    };
    const onWords = (m: { serial: number }, sp: { name: string }) => {
      if (m.serial === this.opponent) {
        this.#note(`${this.opponentName} began casting ${sp.name}`);
      }
    };
    const onJournal = (e: { serial: number; cliloc?: number }) => {
      if (e.cliloc === CLILOC.spellFizzles && e.serial === this.opponent) {
        this.#note(`${this.opponentName}'s spell fizzled`);
      }
    };
    w.on("damage", onDamage);
    w.on("spellWords", onWords);
    w.on("journal", onJournal);

    const ended = new Promise<DuelEnd>((resolve) => {
      const onDeath = (serial: number) => {
        if (serial === this.opponent || serial === w.playerSerial) {
          w.off("death", onDeath);
          const weWon = serial === this.opponent;
          resolve({
            winner: weWon ? this.name : this.opponentName,
            loser: weWon ? this.opponentName : this.name,
            reason: "death",
          });
        }
      };
      w.on("death", onDeath);
      signal.addEventListener("abort", () => {
        w.off("death", onDeath);
        resolve({ winner: null, loser: null, reason: "aborted" });
      });
    });

    // Ask for the opponent's health bar; afterwards the server keeps it current.
    this.session.client.send(out.statusRequest(this.opponent, 4));
    this.session.client.send(out.warMode(true));

    let finished = false;
    void ended.then(() => {
      finished = true;
    });
    try {
      while (!finished && !signal.aborted) {
        await this.#turn(signal, () => finished);
      }
    } finally {
      w.off("damage", onDamage);
      w.off("spellWords", onWords);
      w.off("journal", onJournal);
    }
    const end = await ended;
    this.emit("end", end);
    return end;
  }

  async #turn(signal: AbortSignal, isOver: () => boolean): Promise<void> {
    const w = this.session.world;
    // The opponent's position arrives a moment after the round starts; until then every distance
    // would be measured from 0,0.
    const them = w.mobile(this.opponent);
    if (them.x === 0 && them.y === 0) {
      await sleep(100, signal);
      return;
    }
    // Decide just in time: late enough to see fresh state, early enough to cast the moment we can.
    const lead = this.caster.readyAt - w.now() - this.#latencyEma;
    if (lead > 0) {
      await sleep(Math.min(lead, 150), signal);
      return;
    }

    const snapshot = this.snapshot();
    let decision: Decision;
    try {
      decision = await this.brain.decide(snapshot);
    } catch (err) {
      this.emit("log", `${this.brain.name} failed: ${(err as Error).message}`);
      await sleep(500, signal);
      return;
    }
    if (isOver() || signal.aborted) {
      return;
    }
    this.#latencyEma = 0.7 * this.#latencyEma + 0.3 * decision.latencyMs;

    const record: DecisionRecord = {
      id: this.records.length + 1,
      at: w.now(),
      bot: this.name,
      opponent: this.opponentName,
      decision,
      snapshot,
    };
    this.records.push(record);
    this.emit("decision", record);

    const wait = this.caster.readyAt - w.now();
    if (wait > 0) {
      await sleep(wait, signal);
    }

    const plan = decision.plan;
    let outcome: CastOutcome | null = null;
    switch (plan.kind) {
      case "cast":
        outcome = await this.caster.cast(
          spell(plan.spell),
          plan.target === "self" ? { kind: "self" } : { kind: "mobile", serial: this.opponent },
        );
        break;
      case "teleport":
        outcome = await this.caster.cast(spell("teleport"), { kind: "location", ...plan.tile });
        break;
      case "retreat": {
        const gained = await this.mover.retreat(w.mobile(this.opponent), 4, this.grid());
        record.outcome = { result: gained > 0 ? "moved" : "blocked" };
        this.#note(`${this.name} ran ${gained} tiles away from ${this.opponentName}`);
        if (gained === 0) {
          await sleep(BLOCKED_PAUSE_MS, signal);
        }
        break;
      }
      case "approach": {
        const steps = await this.mover.approach(w.mobile(this.opponent), SPELL_RANGE - 2, 3, this.grid());
        record.outcome = { result: steps > 0 ? "moved" : "blocked" };
        if (steps === 0) {
          await sleep(BLOCKED_PAUSE_MS, signal);
        }
        break;
      }
      case "wait":
        await sleep(plan.ms, signal);
        record.outcome = { result: "waited" };
        break;
    }

    if (outcome) {
      if (outcome.result === "notRecovered") {
        this.caster.readyAt = w.now() + 250;
      }
      if (outcome.result === "cast") {
        this.#lastSpell = { key: outcome.spell.key, at: w.now() };
      }
      this.#note(`${this.name} ${outcome.result === "cast" ? "cast" : `failed (${outcome.result})`} ${outcome.spell.name}`);
      record.outcome = {
        result: outcome.result,
        castMs: outcome.cursorAt ? outcome.cursorAt - outcome.startedAt : undefined,
      };
    }
    this.emit("outcome", record);
  }
}
