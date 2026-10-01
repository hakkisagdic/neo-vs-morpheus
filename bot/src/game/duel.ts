// One bot's side of a duel: observe, ask the brain, act, repeat until someone dies.
import { EventEmitter } from "node:events";
import { PROTECTION_SLOWDOWN_MS, SPELL_RANGE, breaksCasts, teleportTiles } from "../brain/duel-policy.ts";
import { type Archetype, NEUTRAL, type Tactics, tacticsFor } from "../brain/tactics.ts";
import type { Decision, DuelBrain, DuelSnapshot } from "../brain/types.ts";
import { CLILOC } from "../uo/cliloc.ts";
import * as out from "../uo/outgoing.ts";
import { spell } from "../uo/spells.ts";
import { type CastOutcome, Caster, castDelayMs } from "./caster.ts";
import { Grid } from "../world/grid.ts";
import type { Supplies, WeaponView } from "../brain/types.ts";
import {
  GRAPHIC,
  HEAL_POTION_DELAY_MS,
  STAND_STILL_MS,
  abilityMana,
  freeHand,
  packCount,
  selfBandageSeconds,
  setAbility,
  swingDelayMs,
  useItem,
  wielded,
} from "./items.ts";
import { OBSTACLE_GRAPHICS } from "./arena.ts";
import { Mover, RUN_STEP_MS, chebyshev } from "./mover.ts";
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

/** A fighter's decisions come no faster than this: swings, bandages and potions take time to show. */
const SWING_PAUSE_MS = 350;

/** Kiting stops this long before it must: the server marks a step when it handles it, a moment after we send it. */
const KITE_MARGIN_MS = 100;
/** Kiting steps per decision, so that a new decision can change course. */
const KITE_STEPS = 4;

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
  /** A person's settings for this bot; the monitor can change them during a match (setTactics). */
  tactics: Tactics = NEUTRAL;
  /** The spells in the bot's book, from its template; none: the whole book. */
  spells: readonly string[] | undefined;
  /** The spells its profile offers in a fight; none: the default list. */
  offer: readonly string[] | undefined;
  #outOfReachSince: number | null = null;
  #recent: string[] = [];
  #latencyEma = 250;
  #lastSpell: { key: string; at: number } | null = null;
  #bandageUntil = 0;
  #healPotionReadyAt = 0;
  #lastAbilityAt = Number.NEGATIVE_INFINITY;
  #lastAttackAt = 0;
  /** When our weapon swings (or shoots) next, from the last swing the server reported. */
  #nextSwingAt = 0;
  /** The kind of opponent the current tactics were chosen for. */
  #matchup: Archetype | null = null;
  /** Their Protection, toggled by every cast of it we see complete (a hit while it is cast breaks it). */
  #theirProtection = false;
  #theirProtectionCast: { endsAt: number; broken: boolean } | null = null;

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

  /** Skills that make weapon abilities cheaper (ModernUO WeaponAbility.CalculateMana), by 0-based id. */
  static readonly #COMBAT_SKILLS = [5, 30, 31, 40, 41, 42, 44, 47, 52, 53];

  #weaponView(): WeaponView | null {
    const w = wielded(this.session);
    if (!w) {
      return null;
    }
    const skills = this.session.world.skills;
    const total = DuelController.#COMBAT_SKILLS.reduce((sum, id) => sum + (skills.get(id)?.value ?? 0), 0);
    return {
      name: w.name,
      ranged: w.ranged,
      range: w.range,
      primary: w.primary,
      primaryMana: abilityMana(w.primary, total),
      secondary: w.secondary,
      secondaryMana: abilityMana(w.secondary, total),
    };
  }

  #supplies(): Supplies {
    const count = (g: number) => packCount(this.session, g);
    return {
      bandages: count(GRAPHIC.bandage),
      healPotions: count(GRAPHIC.healPotion),
      curePotions: count(GRAPHIC.curePotion),
      refreshPotions: count(GRAPHIC.refreshPotion),
      explosionPotions: count(GRAPHIC.explosionPotion),
      arrows: count(GRAPHIC.arrow),
    };
  }

  /** What kind of opponent this is, by what they wield; null until they have been seen. */
  #archetype(): Archetype | null {
    const t = this.session.world.mobile(this.opponent);
    if (t.updatedAt === 0) {
      return null;
    }
    const weapon = wielded(this.session, t.serial);
    return !weapon ? "caster" : weapon.ranged ? "ranged" : "melee";
  }

  /** Whether to keep away from them now: kiting is on, they fight in melee, and they are too close. */
  #shouldKite(t: Tactics): boolean {
    const them = this.session.world.mobile(this.opponent);
    return t.kite > 0 && this.#archetype() === "melee" && !them.dead && chebyshev(this.session.world.player, them) < t.kite;
  }

  /** Completes a Protection cast of theirs once its cast time has passed unbroken. */
  #settleTheirProtection(now: number): void {
    const cast = this.#theirProtectionCast;
    if (cast && now >= cast.endsAt) {
      if (!cast.broken) {
        this.#theirProtection = !this.#theirProtection;
        this.#note(`${this.opponentName} turned Protection ${this.#theirProtection ? "on" : "off"}`);
      }
      this.#theirProtectionCast = null;
    }
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
    this.#settleTheirProtection(now);
    // Under Protection their casts take 0.5 s longer.
    const theirCastMs = (sp: Parameters<typeof castDelayMs>[0]) => castDelayMs(sp) + (this.#theirProtection ? PROTECTION_SLOWDOWN_MS : 0);
    const casting = t.casting && now - t.casting.since < theirCastMs(t.casting.spell) + 300 ? t.casting : null;
    const distance = chebyshev(p, t);
    const inLineOfSight = grid.lineOfSight(p, t);
    const outOfReach = (distance > SPELL_RANGE || !inLineOfSight) && !t.dead;
    this.#outOfReachSince = outOfReach ? (this.#outOfReachSince ?? now) : null;
    // While a spell of theirs is coming: how many steps to a tile where it cannot be aimed at us.
    let coverSteps: number | undefined;
    if (casting && breaksCasts(casting.spell.key) && !outOfReach) {
      const hide = grid.cover(p, t, 3);
      const hideSteps = hide ? (grid.path(p, hide)?.length ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
      const edge = SPELL_RANGE + 1 - distance;
      const steps = Math.min(hideSteps, edge <= 3 ? edge : Number.POSITIVE_INFINITY);
      coverSteps = Number.isFinite(steps) ? steps : undefined;
    }
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
        weapon: this.#weaponView(),
        bandagingForMs: Math.max(0, this.#bandageUntil - now),
        healPotionReadyInMs: Math.max(0, this.#healPotionReadyAt - now),
        lastAbilityAgoMs: now - this.#lastAbilityAt,
        freeHand: freeHand(this.session),
        outOfReachForMs: this.#outOfReachSince === null ? 0 : now - this.#outOfReachSince,
        coverSteps,
        // ModernUO's buff icons: Protection 1029, Magic Reflection 1031.
        protection: w.buffs.has(1029),
        magicReflection: w.buffs.has(1031),
        spells: this.spells,
        offer: this.offer,
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
        landsInMs: casting ? Math.max(0, casting.since + theirCastMs(casting.spell) - now) : 0,
        distance,
        inLineOfSight,
        inRange: distance <= SPELL_RANGE,
        weapon: wielded(this.session, t.serial)?.name ?? null,
        protection: this.#theirProtection,
      },
      supplies: this.#supplies(),
      reagents: w.reagents(),
      tiles: distance > 2 ? teleportTiles(base as Pick<DuelSnapshot, "us" | "them">, grid) : [],
      recent: [...this.#recent],
    };
  }

  /** New tactics from the next decision on; the match keeps them for the rounds that follow. */
  setTactics(tactics: Tactics): void {
    this.tactics = tactics;
    this.emit("tactics", tactics);
    const matchups = Object.keys(tactics.vs);
    this.emit("log", `tactics now ${tactics.id}: aggression ${tactics.aggression}, heal ${tactics.heal.join("-")}%, ` +
      `retreat ${tactics.retreat.join("-")}%, chase up to ${tactics.chase.maxTiles} tiles for ${tactics.chase.giveUpSeconds} s` +
      `${tactics.kite ? `, kite at ${tactics.kite} tiles` : ""}${matchups.length ? `, matchups for ${matchups.join(", ")}` : ""}`);
  }

  /** Fights until one side dies or `signal` aborts. */
  async run(signal: AbortSignal): Promise<DuelEnd> {
    const w = this.session.world;
    const onDamage = (serial: number, amount: number) => {
      if (serial === this.opponent) {
        const cast = this.#theirProtectionCast;
        if (cast && !this.#theirProtection && w.now() < cast.endsAt) {
          cast.broken = true; // a hit breaks the cast unless Protection is already on
        }
        this.#note(`${this.opponentName} took ${amount} damage`);
      } else if (serial === w.playerSerial) {
        this.#note(`${this.name} took ${amount} damage`);
      }
    };
    const onWords = (m: { serial: number }, sp: Parameters<typeof castDelayMs>[0]) => {
      if (m.serial === this.opponent) {
        if (sp.key === "protection") {
          this.#settleTheirProtection(w.now());
          const slower = this.#theirProtection ? PROTECTION_SLOWDOWN_MS : 0;
          this.#theirProtectionCast = { endsAt: w.now() + castDelayMs(sp) + slower, broken: false };
        }
        this.#note(`${this.opponentName} began casting ${sp.name}`);
      }
    };
    const onJournal = (e: { serial: number; cliloc?: number }) => {
      if (e.cliloc === CLILOC.spellFizzles && e.serial === this.opponent) {
        if (this.#theirProtectionCast) {
          this.#theirProtectionCast.broken = true;
        }
        this.#note(`${this.opponentName}'s spell fizzled`);
      }
    };
    const onSwing = (attacker: number) => {
      const weapon = wielded(this.session);
      if (attacker === w.playerSerial && weapon) {
        this.#nextSwingAt = w.now() + swingDelayMs(weapon, w.player.stam);
      }
    };
    w.on("damage", onDamage);
    w.on("spellWords", onWords);
    w.on("journal", onJournal);
    w.on("swing", onSwing);

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
      w.off("swing", onSwing);
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
    // The tactics for this kind of opponent, once we see what they wield.
    const kind = this.#archetype();
    const tactics = tacticsFor(this.tactics, kind);
    if (kind !== this.#matchup) {
      this.#matchup = kind;
      if (tactics !== this.tactics) {
        this.emit("log", `${this.name} faces a ${kind} fighter: tactics ${tactics.id}`);
      }
    }

    // Decide just in time: late enough to see fresh state, early enough to cast the moment we can.
    // Until then a caster keeps away from a melee opponent, if the tactics say so.
    const lead = this.caster.readyAt - w.now() - this.#latencyEma;
    if (lead > 0) {
      const room = () => this.caster.readyAt - w.now() - this.#latencyEma - KITE_MARGIN_MS;
      if (room() >= RUN_STEP_MS && this.#shouldKite(tactics)) {
        const steps = Math.min(KITE_STEPS, Math.floor(room() / RUN_STEP_MS));
        await this.mover.kite(them, steps, this.grid(), () => room() < RUN_STEP_MS || !this.#shouldKite(tactics));
        return;
      }
      await sleep(Math.min(lead, 150), signal);
      return;
    }

    const snapshot = this.snapshot();
    let decision: Decision;
    try {
      decision = await this.brain.decide(snapshot, tactics);
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
      case "attack": {
        const client = this.session.client;
        if (plan.ability) {
          const weapon = wielded(this.session);
          if (weapon) {
            setAbility(this.session, plan.ability === "primary" ? weapon.primary : weapon.secondary);
            this.#lastAbilityAt = w.now();
          }
        }
        // The server swings on its own clock once we attack; asking again now and then keeps it on target.
        if (plan.ability || w.now() - this.#lastAttackAt > 2_000) {
          client.send(out.attack(this.opponent));
          this.#lastAttackAt = w.now();
        }
        const reach = wielded(this.session)?.range ?? 1;
        const grid = this.grid();
        const them = w.mobile(this.opponent);
        // Kiting with a bow: run while it reloads, and stand still in time for the next shot.
        const room = () => this.#nextSwingAt - STAND_STILL_MS - KITE_MARGIN_MS - w.now();
        if (chebyshev(w.player, them) > reach || !grid.lineOfSight(w.player, them)) {
          const steps = await this.mover.approach(them, reach, 3, grid);
          record.outcome = { result: steps > 0 ? "closing" : "blocked" };
          if (steps === 0) {
            await sleep(BLOCKED_PAUSE_MS, signal);
          }
        } else if (wielded(this.session)?.ranged && room() >= RUN_STEP_MS && this.#shouldKite(tactics)) {
          const steps = Math.min(KITE_STEPS, Math.floor(room() / RUN_STEP_MS));
          const taken = await this.mover.kite(them, steps, grid, () => room() < RUN_STEP_MS || !this.#shouldKite(tactics));
          record.outcome = { result: taken > 0 ? "kiting" : "swinging" };
          if (taken === 0) {
            await sleep(SWING_PAUSE_MS, signal);
          }
        } else {
          await sleep(SWING_PAUSE_MS, signal);
          record.outcome = { result: "swinging" };
        }
        break;
      }
      case "bandage": {
        const used = await useItem(this.session, GRAPHIC.bandage, { kind: "self" });
        if (used === "used") {
          this.#bandageUntil = w.now() + selfBandageSeconds(this.session.world.stats.dex || 100) * 1000;
        }
        record.outcome = { result: used };
        this.#note(`${this.name} ${used === "used" ? "began bandaging" : `could not bandage (${used})`}`);
        await sleep(SWING_PAUSE_MS, signal);
        break;
      }
      case "drink": {
        const graphic = { heal: GRAPHIC.healPotion, cure: GRAPHIC.curePotion, refresh: GRAPHIC.refreshPotion }[plan.potion];
        const used = await useItem(this.session, graphic, null);
        if (used === "used" && plan.potion === "heal") {
          this.#healPotionReadyAt = w.now() + HEAL_POTION_DELAY_MS;
        }
        record.outcome = { result: used };
        this.#note(`${this.name} ${used === "used" ? `drank a ${plan.potion} potion` : `could not drink (${used})`}`);
        await sleep(SWING_PAUSE_MS, signal);
        break;
      }
      case "throw": {
        const used = await useItem(this.session, GRAPHIC.explosionPotion, { kind: "mobile", serial: this.opponent });
        record.outcome = { result: used };
        this.#note(`${this.name} ${used === "used" ? "threw an explosion potion" : `could not throw (${used})`}`);
        await sleep(SWING_PAUSE_MS, signal);
        break;
      }
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
