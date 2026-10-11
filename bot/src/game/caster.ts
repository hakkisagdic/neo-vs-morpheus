// Casting: send the spell, answer its target cursor, and report what happened.
//
// ModernUO timing: the cast delay is (3 + circle index) * 0.25 s for Magery, a spell's own for
// Necromancy and Chivalry; when it ends the target cursor appears and the next spell becomes
// available the spell's recovery later (1.5 s, Chivalry's 1.75 s). A player hurt during the cast
// delay loses the spell (unless protected).
//
// Chivalry fizzles quietly: no "The spell fizzles", only its sound (0x1D6) where the caster
// stands, and no recovery after it (PaladinSpell.DoFizzle).
//
// A Magery spell without a cursor is taken as cast once its delay has passed without a failure,
// and its recovery is counted from 300 ms before that guess; but the server's cast timer ends a
// little later (much later on a loaded machine), and after two in five such successes the Magery
// trainer's next cast came too early ("You have not yet recovered"). Necromancy's and Chivalry's
// casts wait for their outcome instead: the mana a success spends, which reaches the client as the
// server ends the delay, or the fizzle. Magery keeps the guess: its sessions and duels were
// recorded with it.
import { CLILOC } from "../uo/cliloc.ts";
import * as out from "../uo/outgoing.ts";
import type { Spell } from "../uo/spells.ts";
import type { JournalEntry, TargetCursor } from "../world/world.ts";
import type { Session } from "./session.ts";

export const CAST_RECOVERY_MS = 1500;
export const castDelayMs = (spell: Spell): number => spell.delayMs;

/** The sound a Chivalry spell makes when it fizzles or is disturbed. */
export const PALADIN_FIZZLE_SOUND = 0x1d6;

export type CastTarget =
  | { kind: "mobile"; serial: number }
  | { kind: "self" }
  | { kind: "location"; x: number; y: number; z: number };

export type CastResult =
  | "cast"
  | "fizzled"
  | "disturbed"
  | "noMana"
  | "noReagents"
  | "noTithing"
  | "noSpell"
  | "wrongForm"
  | "notRecovered"
  | "alreadyCasting"
  | "notSeen"
  | "tooFar"
  | "blocked"
  | "timeout";

export type CastOutcome = {
  spell: Spell;
  result: CastResult;
  startedAt: number;
  /** When the target cursor appeared, i.e. when the cast delay ended. */
  cursorAt?: number;
  endedAt: number;
};

const FAILURES = new Map<number, CastResult>([
  [CLILOC.spellFizzles, "fizzled"],
  [CLILOC.concentrationDisturbed, "disturbed"],
  [CLILOC.insufficientMana, "noMana"],
  [CLILOC.insufficientManaNew, "noMana"],
  [CLILOC.moreReagents, "noReagents"],
  [CLILOC.noTithing, "noTithing"],
  [CLILOC.noSpell, "noSpell"],
  [CLILOC.wrongForm, "wrongForm"],
  [CLILOC.notRecovered, "notRecovered"],
  [CLILOC.alreadyCasting, "alreadyCasting"],
  [CLILOC.targetNotSeen, "notSeen"],
  [CLILOC.tooFar, "tooFar"],
  [CLILOC.cannotTeleport, "blocked"],
]);

export class Caster {
  readonly session: Session;
  /** The spell in flight, if any. */
  current: { spell: Spell; since: number } | null = null;
  /** Earliest time the server will accept another cast. */
  readyAt = 0;

  constructor(session: Session) {
    this.session = session;
  }

  get busy(): boolean {
    return this.current !== null;
  }

  cast(spell: Spell, target: CastTarget): Promise<CastOutcome> {
    const { client, world } = this.session;
    if (world.target) {
      client.send(out.cancelTarget(world.target.id)); // a stale cursor would swallow ours
      world.target = null;
    }

    const startedAt = world.now();
    this.current = { spell, since: startedAt };

    return new Promise((resolve) => {
      let cursorAt: number | undefined;
      let done = false;

      const finish = (result: CastResult) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        world.off("target", onTarget);
        world.off("journal", onJournal);
        world.off("sound", onSound);
        world.off("mana", onMana);
        const endedAt = world.now();
        this.current = null;
        if (result === "fizzled" && spell.school === "chivalry") {
          this.readyAt = endedAt; // no recovery after a Chivalry fizzle
        } else if (result === "cast" || result === "fizzled") {
          this.readyAt = (cursorAt ?? endedAt) + spell.recoveryMs;
        } else if (result === "disturbed") {
          this.readyAt = endedAt + CAST_RECOVERY_MS;
        }
        resolve({ spell, result, startedAt, cursorAt, endedAt });
      };

      const onTarget = (cursor: TargetCursor) => {
        cursorAt = world.now();
        client.send(this.#answer(cursor, target));
        world.target = null;
        // The effect is applied now; a fizzle, if any, is reported right after.
        setTimeout(() => finish("cast"), 100);
      };

      const onJournal = (entry: JournalEntry) => {
        const failure = entry.cliloc !== undefined ? FAILURES.get(entry.cliloc) : undefined;
        if (failure) {
          finish(failure);
        }
      };

      // A disturbed Chivalry spell plays the same sound, after its message (seen first above).
      const onSound = (id: number, x: number, y: number) => {
        const p = world.player;
        if (spell.school === "chivalry" && id === PALADIN_FIZZLE_SOUND && x === p.x && y === p.y) {
          cursorAt = world.now();
          finish("fizzled");
        }
      };

      // Self and untargeted spells (Magic Reflection, Earthquake, ...) show no cursor: they are
      // done once the cast delay passes without a failure message.
      const noCursor = spell.target === "self" || spell.target === "none";

      // Regeneration only adds mana: a drop is the success, as the server sequences the spell.
      const onMana = (before: number, after: number) => {
        if (noCursor && spell.school !== "magery" && after < before) {
          cursorAt = world.now();
          finish("cast");
        }
      };

      // Necromancy and Chivalry are told their outcome either way (mana spent, a fizzle message or
      // sound), so they wait for it however long a loaded server takes, and never guess.
      const guess = noCursor && spell.school === "magery";
      const timer = guess
        ? setTimeout(() => {
            cursorAt = world.now() - 300;
            finish("cast");
          }, castDelayMs(spell) + 300)
        : setTimeout(() => finish("timeout"), castDelayMs(spell) + (noCursor ? 5_000 : 2_500));
      world.on("target", onTarget);
      world.on("journal", onJournal);
      world.on("sound", onSound);
      world.on("mana", onMana);
      client.send(out.castSpell(spell.id));
    });
  }

  #answer(cursor: TargetCursor, target: CastTarget): Uint8Array {
    const { world } = this.session;
    if (target.kind === "location") {
      return out.targetLocation(cursor.id, cursor.flags, target.x, target.y, target.z);
    }
    const serial = target.kind === "self" ? world.playerSerial : target.serial;
    const m = world.mobiles.get(serial);
    return out.targetObject(cursor.id, cursor.flags, serial, m?.x ?? 0, m?.y ?? 0, m?.z ?? 0, m?.body ?? 0);
  }
}
