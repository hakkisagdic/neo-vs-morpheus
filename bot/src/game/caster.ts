// Casting: send the spell, answer its target cursor, and report what happened.
//
// ModernUO timing: the cast delay is (3 + circle index) * 0.25 s; when it ends the target cursor
// appears and the next spell becomes available CAST_RECOVERY_MS later. A player hurt during the
// cast delay loses the spell (unless protected).
import { CLILOC } from "../uo/cliloc.ts";
import * as out from "../uo/outgoing.ts";
import type { Spell } from "../uo/spells.ts";
import type { JournalEntry, TargetCursor } from "../world/world.ts";
import type { Session } from "./session.ts";

export const CAST_RECOVERY_MS = 1500;
export const castDelayMs = (spell: Spell): number => (2 + spell.circle) * 250;

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
        const endedAt = world.now();
        this.current = null;
        if (result === "cast" || result === "fizzled") {
          this.readyAt = (cursorAt ?? endedAt) + CAST_RECOVERY_MS;
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

      // Self and untargeted spells (Magic Reflection, Earthquake, ...) show no cursor: they are
      // done once the cast delay passes without a failure message.
      const noCursor = spell.target === "self" || spell.target === "none";
      const timer = noCursor
        ? setTimeout(() => {
            cursorAt = world.now() - 300;
            finish("cast");
          }, castDelayMs(spell) + 300)
        : setTimeout(() => finish("timeout"), castDelayMs(spell) + 2_500);
      world.on("target", onTarget);
      world.on("journal", onJournal);
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
