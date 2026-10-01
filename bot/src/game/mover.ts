// Walking: move requests carry a sequence number the server acknowledges in order.
// A request in a direction we are not facing only turns us.
import * as out from "../uo/outgoing.ts";
import type { Grid, Point } from "../world/grid.ts";
import type { Session } from "./session.ts";

const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];
/** A running step takes 200 ms on foot (Movement.RunFootDelay); a little more keeps the server from refusing one. */
export const RUN_STEP_MS = 210;

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
    // Straight away first, a diagonal beside it only when a step is refused. A step in a new
    // direction only turns us, so the same direction is asked again (switching direction on every
    // try, as this once did, turned the bot on the spot and it never got away).
    let side = 0;
    for (let tries = 0; steps < maxSteps && tries < maxSteps * 3; tries++) {
      const away = (directionTo(this.session.world.player, from) + 4) % 8;
      const direction = side === 0 ? away : (away + (side === 1 ? 1 : 7)) % 8;
      const facing = this.session.world.player.direction === direction;
      if (!(await this.step(direction))) {
        side = (side + 1) % 3;
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
   * Kiting: keeps away from a threat without hiding from it, so that it stays in sight to be shot
   * at. Each step goes to the free neighbouring tile farthest from the threat, in its line of
   * sight, as straight away as possible; none once `stop` holds or no step gains distance. A
   * refused step is not asked again. Returns the steps taken.
   */
  async kite(from: { x: number; y: number }, maxSteps: number, grid?: Grid, stop: () => boolean = () => false): Promise<number> {
    const player = this.session.world.player;
    const refused = new Set<number>();
    let steps = 0;
    for (let tries = 0; steps < maxSteps && tries < maxSteps * 3 && !stop(); tries++) {
      const direction = kiteDirection(player, from, grid, refused);
      if (direction === null) {
        break;
      }
      const facing = player.direction === direction;
      if (!(await this.step(direction))) {
        refused.add(direction);
        continue;
      }
      if (facing) {
        steps++;
        refused.clear();
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

/**
 * The direction of the best kiting step: onto a free tile that is farther from the threat than
 * where we stand, keeping it in sight when there are obstacles, the straightest away first; null
 * when no step gains distance (cornered).
 */
export function kiteDirection(
  at: { x: number; y: number },
  threat: { x: number; y: number },
  grid?: Grid,
  refused: ReadonlySet<number> = new Set(),
): number | null {
  const away = (directionTo(at, threat) + 4) % 8;
  const now = chebyshev(at, threat);
  let best: { direction: number; score: number } | null = null;
  for (let d = 0; d < 8; d++) {
    const tile = { x: at.x + DX[d], y: at.y + DY[d] };
    if (refused.has(d) || grid?.isBlocked(tile) || chebyshev(tile, threat) <= now) {
      continue;
    }
    const turn = Math.min((d - away + 8) % 8, (away - d + 8) % 8); // 0 = straight away
    const score = (grid && !grid.lineOfSight(tile, threat) ? 0 : 100) - turn;
    if (!best || score > best.score) {
      best = { direction: d, score };
    }
  }
  return best?.direction ?? null;
}
