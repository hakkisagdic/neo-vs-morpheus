// Walking: move requests carry a sequence number the server acknowledges in order.
// A request in a direction we are not facing only turns us.
import * as out from "../uo/outgoing.ts";
import type { Session } from "./session.ts";

const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];
const RUN_STEP_MS = 210;

export const chebyshev = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Direction 0..7 (north, clockwise) from one tile towards another. */
export function directionTo(from: { x: number; y: number }, to: { x: number; y: number }): number {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  for (let d = 0; d < 8; d++) {
    if (DX[d] === dx && DY[d] === dy) {
      return d;
    }
  }
  return 0;
}

export class Mover {
  readonly session: Session;
  #seq = 0;

  constructor(session: Session) {
    this.session = session;
  }

  /** One request; resolves true when the server accepted it. */
  step(direction: number, run = true): Promise<boolean> {
    const { client, world } = this.session;
    const seq = this.#seq;
    this.#seq = this.#seq === 255 ? 1 : this.#seq + 1;
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        world.off("moveAck", onAck);
        world.off("moveReject", onReject);
        resolve(ok);
      };
      const onAck = (acked: number) => {
        if (acked !== seq) {
          return;
        }
        const p = world.player;
        if (p.direction === direction) {
          p.x += DX[direction];
          p.y += DY[direction];
        } else {
          p.direction = direction;
        }
        done(true);
      };
      const onReject = () => {
        this.#seq = 0; // the server restarts the sequence after a rejection
        done(false);
      };
      const timer = setTimeout(() => done(false), 1_000);
      world.on("moveAck", onAck);
      world.on("moveReject", onReject);
      client.send(out.moveRequest(direction, seq, run));
    });
  }

  /** Runs towards a point until within `stopAt` tiles, taking at most `maxSteps` steps. */
  async approach(target: { x: number; y: number }, stopAt: number, maxSteps = 4): Promise<number> {
    let steps = 0;
    while (steps < maxSteps && chebyshev(this.session.world.player, target) > stopAt) {
      const direction = directionTo(this.session.world.player, target);
      const facing = this.session.world.player.direction === direction;
      if (!(await this.step(direction))) {
        break;
      }
      if (facing) {
        steps++;
      }
      await new Promise((r) => setTimeout(r, RUN_STEP_MS));
    }
    return steps;
  }
}
