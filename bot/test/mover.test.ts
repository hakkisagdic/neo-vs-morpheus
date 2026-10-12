import { afterEach, describe, expect, it, vi } from "vitest";
import { Mover, RUN_STEP_MS } from "../src/game/mover.ts";

const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];

/** A mover on a floor with some blocked tiles: a step in a new direction only turns. */
function fakeMover(start: { x: number; y: number; direction: number }, blocked: string[] = []) {
  const player = { ...start };
  const session = { world: { player } } as never;
  const mover = new Mover(session);
  mover.step = async (direction: number) => {
    if (player.direction !== direction) {
      player.direction = direction;
      return true;
    }
    if (blocked.includes(`${player.x + DX[direction]},${player.y + DY[direction]}`)) {
      return false;
    }
    player.x += DX[direction];
    player.y += DY[direction];
    return true;
  };
  return { mover, player };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("retreat", () => {
  it("turns once, then runs straight away", async () => {
    // Facing the opponent to the east; away is west (direction 6).
    const { mover, player } = fakeMover({ x: 10, y: 10, direction: 2 });
    const gained = await mover.retreat({ x: 11, y: 10 }, 4);
    expect(gained).toBe(4);
    expect(player).toMatchObject({ x: 6, y: 10 });
  });

  it("waits out the running pace after a step but not after a turn", async () => {
    vi.useFakeTimers();
    const { mover, player } = fakeMover({ x: 10, y: 10, direction: 2 });
    let gained: number | null = null;
    void mover.retreat({ x: 11, y: 10 }, 4).then((n) => (gained = n));
    // One turn and four steps: four paces, not five.
    await vi.advanceTimersByTimeAsync(4 * RUN_STEP_MS);
    expect(gained).toBe(4);
    expect(player).toMatchObject({ x: 6, y: 10 });
  });

  it("takes a diagonal when the tile straight behind is blocked", async () => {
    const { mover, player } = fakeMover({ x: 10, y: 10, direction: 6 }, ["9,10"]);
    const gained = await mover.retreat({ x: 11, y: 10 }, 3);
    expect(gained).toBe(3);
    expect(player.x).toBeLessThan(10);
    expect(player.y).not.toBe(10);
  });
});
