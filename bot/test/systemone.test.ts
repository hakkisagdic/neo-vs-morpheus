import { afterEach, describe, expect, it, vi } from "vitest";
import { systemOne } from "../src/brain/systemone.ts";

const question = { move: { type: "choice" as const, instructions: "pick", criteria: { a: "A", b: "B" } } };

function answering(body: unknown) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 200 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("systemOne", () => {
  it("names a laya-serve answer after the checkpoint that gave it", async () => {
    answering({ model: "laya-rl-agent", answers: { move: { choice: "a" } }, routing: { repo: "/content/arena/models/neo-duel-v8-dagger/" } });
    const d = await systemOne({ name: "laya", url: "http://127.0.0.1:8001" }, "state", question);
    expect(d.model).toBe("neo-duel-v8-dagger");
  });

  it("keeps the model name the server reports otherwise", async () => {
    answering({ model: "laya-rl-agent", answers: { move: { choice: "b" } } });
    expect((await systemOne({ name: "laya", url: "http://x" }, "state", question)).model).toBe("laya-rl-agent");
    answering({ model: "jev-latest", answers: { move: { choice: "b" } }, routing: { repo: "/elsewhere" } });
    expect((await systemOne({ name: "jev", url: "http://x" }, "state", question)).model).toBe("jev-latest");
  });
});
