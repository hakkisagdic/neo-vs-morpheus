import { describe, expect, it } from "vitest";
import { Grid, chebyshev } from "../src/world/grid.ts";

const wall = (x: number, ys: number[]) => ys.map((y) => ({ x, y }));

describe("line of sight", () => {
  it("is clear on open ground and blocked by a pillar in between", () => {
    const g = new Grid([{ x: 5, y: 0 }]);
    expect(g.lineOfSight({ x: 0, y: 3 }, { x: 10, y: 3 })).toBe(true);
    expect(g.lineOfSight({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(false);
  });

  it("never counts the end tiles themselves", () => {
    const g = new Grid([{ x: 0, y: 0 }]);
    expect(g.lineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
  });
});

describe("paths", () => {
  it("walks straight on open ground, one step per tile of distance", () => {
    const route = new Grid().path({ x: 0, y: 0 }, { x: 6, y: 3 });
    expect(route).toHaveLength(6);
    expect(route?.at(-1)).toEqual({ x: 6, y: 3 });
  });

  it("goes around a wall without stepping on it or cutting its corners", () => {
    const g = new Grid(wall(3, [-2, -1, 0, 1, 2]));
    const route = g.path({ x: 0, y: 0 }, { x: 6, y: 0 });
    expect(route).not.toBeNull();
    let at = { x: 0, y: 0 };
    for (const p of route ?? []) {
      expect(g.isBlocked(p)).toBe(false);
      expect(chebyshev(at, p)).toBe(1);
      if (p.x !== at.x && p.y !== at.y) {
        expect(g.isBlocked({ x: p.x, y: at.y }) || g.isBlocked({ x: at.x, y: p.y })).toBe(false);
      }
      at = p;
    }
  });

  it("gives up when the goal is walled in", () => {
    const g = new Grid([...wall(4, [-1, 0, 1]), ...wall(6, [-1, 0, 1]), { x: 5, y: -1 }, { x: 5, y: 1 }]);
    expect(g.path({ x: 0, y: 0 }, { x: 5, y: 0 }, 2_000)).toBeNull();
  });
});

describe("cover", () => {
  it("finds the nearest tile behind a wall, out of the threat's sight", () => {
    const g = new Grid(wall(5, [-1, 0, 1]));
    const threat = { x: 0, y: 0 };
    const hide = g.cover({ x: 4, y: 3 }, threat);
    expect(hide).not.toBeNull();
    expect(g.lineOfSight(hide as { x: number; y: number }, threat)).toBe(false);
    expect(g.path({ x: 4, y: 3 }, hide as { x: number; y: number })?.length).toBeLessThanOrEqual(3);
  });

  it("finds none on open ground", () => {
    expect(new Grid().cover({ x: 4, y: 3 }, { x: 0, y: 0 })).toBeNull();
  });
});
