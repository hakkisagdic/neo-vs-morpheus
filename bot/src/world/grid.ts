// Walkable tiles, line of sight and paths on a flat map. The arena's pillars and walls fill it
// now; the real map's statics will later. Moves are the game's eight directions, so distances
// are Chebyshev (a diagonal step costs the same as a straight one).

export type Point = { x: number; y: number };

const DIRS: Point[] = [
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
];

export const chebyshev = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const key = (p: Point) => `${p.x},${p.y}`;

export class Grid {
  readonly #blocked = new Set<string>();

  constructor(blocked: Iterable<Point> = []) {
    for (const p of blocked) {
      this.block(p);
    }
  }

  block(p: Point): void {
    this.#blocked.add(key(p));
  }

  unblock(p: Point): void {
    this.#blocked.delete(key(p));
  }

  isBlocked(p: Point): boolean {
    return this.#blocked.has(key(p));
  }

  /**
   * Whether a straight line between two tiles misses every blocking tile in between (Bresenham;
   * the end tiles themselves never block). The server's check is three-dimensional, but pillars
   * and walls are taller than a mobile, so on flat ground the two agree.
   */
  lineOfSight(a: Point, b: Point): boolean {
    let { x, y } = a;
    const dx = Math.abs(b.x - a.x);
    const dy = -Math.abs(b.y - a.y);
    const sx = a.x < b.x ? 1 : -1;
    const sy = a.y < b.y ? 1 : -1;
    let err = dx + dy;
    while (x !== b.x || y !== b.y) {
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
      if ((x !== b.x || y !== b.y) && this.isBlocked({ x, y })) {
        return false;
      }
    }
    return true;
  }

  /** The tiles to walk from `from` to `to` (both excluded from the check, `to` included), or null. */
  path(from: Point, to: Point, maxNodes = 4_000): Point[] | null {
    const open: { p: Point; f: number }[] = [{ p: from, f: chebyshev(from, to) }];
    const g = new Map<string, number>([[key(from), 0]]);
    const came = new Map<string, Point>();
    let expanded = 0;
    while (open.length && expanded++ < maxNodes) {
      open.sort((a, b) => a.f - b.f);
      const { p } = open.shift() as { p: Point; f: number };
      if (p.x === to.x && p.y === to.y) {
        const out: Point[] = [];
        for (let c: Point | undefined = p; c && key(c) !== key(from); c = came.get(key(c))) {
          out.unshift(c);
        }
        return out;
      }
      for (const d of DIRS) {
        const n = { x: p.x + d.x, y: p.y + d.y };
        const isGoal = n.x === to.x && n.y === to.y;
        // No squeezing diagonally between two blocked tiles, as in the game.
        const cutsCorner = d.x !== 0 && d.y !== 0 && (this.isBlocked({ x: p.x + d.x, y: p.y }) || this.isBlocked({ x: p.x, y: p.y + d.y }));
        if ((!isGoal && this.isBlocked(n)) || cutsCorner) {
          continue;
        }
        const cost = (g.get(key(p)) ?? 0) + 1;
        if (cost < (g.get(key(n)) ?? Number.POSITIVE_INFINITY)) {
          g.set(key(n), cost);
          came.set(key(n), p);
          open.push({ p: n, f: cost + chebyshev(n, to) });
        }
      }
    }
    return null;
  }

  /**
   * The nearest reachable tile, within `maxSteps` steps, that the threat cannot see: where to run
   * to break line of sight. Ties go to the tile farther from the threat.
   */
  cover(from: Point, threat: Point, maxSteps = 6): Point | null {
    let best: { p: Point; steps: number; away: number } | null = null;
    for (let dx = -maxSteps; dx <= maxSteps; dx++) {
      for (let dy = -maxSteps; dy <= maxSteps; dy++) {
        const p = { x: from.x + dx, y: from.y + dy };
        if (this.isBlocked(p) || this.lineOfSight(p, threat)) {
          continue;
        }
        const route = this.path(from, p, 600);
        if (!route || route.length > maxSteps) {
          continue;
        }
        const away = chebyshev(p, threat);
        if (!best || route.length < best.steps || (route.length === best.steps && away > best.away)) {
          best = { p, steps: route.length, away };
        }
      }
    }
    return best?.p ?? null;
  }
}
