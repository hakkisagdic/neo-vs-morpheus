// Walking: move requests carry a sequence number the server acknowledges in order.
// A request in a direction we are not facing only turns us.
import * as out from "../uo/outgoing.ts";
import type { Grid, Point } from "../world/grid.ts";
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

  /**
   * Walks a path tile by tile, at most `maxSteps` steps, stopping early once `done` holds. A step
   * in a direction we are not facing only turns us, so it is asked again.
   */
  async #follow(path: Point[], maxSteps: number, done: () => boolean = () => false): Promise<number> {
    let steps = 0;
    for (let i = 0, tries = 0; i < path.length && steps < maxSteps && tries < maxSteps * 3 && !done(); tries++) {
      const direction = directionTo(this.session.world.player, path[i]);
      const facing = this.session.world.player.direction === direction;
      if (!(await this.step(direction))) {
        break;
      }
      if (facing) {
        steps++;
        i++;
      }
      await new Promise((r) => setTimeout(r, RUN_STEP_MS));
    }
    return steps;
  }

  /**
   * Runs from a threat. With obstacles around, to the nearest tile it cannot see; otherwise
   * directly away, sidestepping when blocked. Returns tiles gained.
   */
  async retreat(from: { x: number; y: number }, maxSteps = 4, grid?: Grid): Promise<number> {
    const hide = grid?.cover(this.session.world.player, from, maxSteps);
    const route = hide && grid ? grid.path(this.session.world.player, hide) : null;
    if (route) {
      return this.#follow(route, maxSteps);
    }
    let steps = 0;
    for (let tries = 0; steps < maxSteps && tries < maxSteps * 3; tries++) {
      const away = (directionTo(this.session.world.player, from) + 4) % 8;
      const direction = tries % 3 === 0 ? away : (away + (tries % 3 === 1 ? 1 : 7)) % 8;
      const facing = this.session.world.player.direction === direction;
      if (!(await this.step(direction))) {
        continue;
      }
      if (facing) {
        steps++;
      }
      await new Promise((r) => setTimeout(r, RUN_STEP_MS));
    }
    return steps;
  }

  /**
   * Runs towards a point until within `stopAt` tiles (and, with obstacles around, in its sight),
   * taking at most `maxSteps` steps; around the obstacles when a grid is given.
   */
  async approach(target: { x: number; y: number }, stopAt: number, maxSteps = 4, grid?: Grid): Promise<number> {
    if (grid) {
      const player = this.session.world.player;
      const route = grid.path(player, target);
      const there = () => chebyshev(player, target) <= stopAt && grid.lineOfSight(player, target);
      return route ? this.#follow(route.slice(0, -1), maxSteps, there) : 0;
    }
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
