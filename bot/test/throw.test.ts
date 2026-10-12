import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTION_DELAY_MS, EXPLOSION_COOK_MS, GRAPHIC, throwCooked } from "../src/game/items.ts";

afterEach(() => {
  vi.useRealTimers();
});

/** A session whose pack holds one explosion potion; every packet sent is kept, as bytes. */
function fakeSession() {
  const world = Object.assign(new EventEmitter(), {
    backpack: 0x40000010,
    target: null as null | { id: number; flags: number },
    items: new Map([[0x40000020, { serial: 0x40000020, graphic: GRAPHIC.explosionPotion, amount: 1, container: 0x40000010, hue: 0 }]]),
    mobiles: new Map([[2, { serial: 2, x: 14, y: 10, z: 0, body: 400 }]]),
  });
  const sent: Uint8Array[] = [];
  return { session: { world, client: { send: (p: Uint8Array) => sent.push(p) } } as never, world, sent };
}

describe("a cooked explosion potion", () => {
  it("is held until ready, then thrown at the target", async () => {
    vi.useFakeTimers();
    const { session, world, sent } = fakeSession();
    let near = false;
    const thrown = throwCooked(session, GRAPHIC.explosionPotion, () => ({ kind: "mobile", serial: 2 }), () => near);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0][0]).toBe(0x06); // primed with a double click
    world.emit("target", { id: 77, type: 0, flags: 0, at: 0 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(1); // still held
    near = true;
    await vi.advanceTimersByTimeAsync(100);
    const { result, heldMs } = await thrown;
    expect(result).toBe("used");
    expect(heldMs).toBeGreaterThanOrEqual(2_000);
    expect(heldMs).toBeLessThan(EXPLOSION_COOK_MS);
    expect(sent[1][0]).toBe(0x6c);
    expect(sent[1][1]).toBe(0); // at an object: the target
  });

  it("is thrown when the cook time is up, at the place it is given", async () => {
    vi.useFakeTimers();
    const { session, world, sent } = fakeSession();
    const thrown = throwCooked(session, GRAPHIC.explosionPotion, () => ({ kind: "location", x: 6, y: 10, z: 0 }), () => false);
    await vi.advanceTimersByTimeAsync(0);
    world.emit("target", { id: 78, type: 0, flags: 0, at: 0 });
    await vi.advanceTimersByTimeAsync(EXPLOSION_COOK_MS + 100);
    const { result, heldMs } = await thrown;
    expect(result).toBe("used");
    expect(heldMs).toBeGreaterThanOrEqual(EXPLOSION_COOK_MS);
    expect(sent[1][1]).toBe(1); // at a ground location
  });

  it("gives up when no target cursor comes", async () => {
    vi.useFakeTimers();
    const { session } = fakeSession();
    const thrown = throwCooked(session, GRAPHIC.explosionPotion, () => ({ kind: "mobile", serial: 2 }), () => true);
    await vi.advanceTimersByTimeAsync(1_100);
    expect((await thrown).result).toBe("refused");
  });
});

describe("item uses", () => {
  it("wait out the server's second between double-clicks", async () => {
    vi.useFakeTimers();
    const { session, world, sent } = fakeSession();
    const first = throwCooked(session, GRAPHIC.explosionPotion, () => ({ kind: "mobile", serial: 2 }), () => true);
    await vi.advanceTimersByTimeAsync(0);
    world.emit("target", { id: 79, type: 0, flags: 0, at: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).result).toBe("used");
    const clicks = () => sent.filter((p) => p[0] === 0x06).length;
    void throwCooked(session, GRAPHIC.explosionPotion, () => ({ kind: "mobile", serial: 2 }), () => true);
    await vi.advanceTimersByTimeAsync(500);
    expect(clicks()).toBe(1); // the second waits
    await vi.advanceTimersByTimeAsync(ACTION_DELAY_MS);
    expect(clicks()).toBe(2);
  });
});
