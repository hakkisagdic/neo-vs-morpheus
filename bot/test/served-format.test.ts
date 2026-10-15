import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelBrain } from "../src/brain/brains.ts";

/** A stand-in for laya-serve: names the checkpoint folder in its routing, as the real one does. */
async function server(repo: string) {
  const s = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "laya-rl-agent", answers: { q: { type: "noul", noul: 0.1 } }, routing: { repo } }));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
}

describe("the melee text a served checkpoint learned", () => {
  it("is what its config says, melee-2 when it says nothing", async () => {
    const three = mkdtempSync(join(tmpdir(), "ckpt-"));
    writeFileSync(join(three, "rl_agent_config.json"), JSON.stringify({ training: { format: { melee: { describe: "melee-3", question: "melee-2" } } } }));
    const old = mkdtempSync(join(tmpdir(), "ckpt-"));
    writeFileSync(join(old, "rl_agent_config.json"), JSON.stringify({ training: { epochs: 3 } }));
    for (const [repo, want] of [[three, "melee-3"], [old, "melee-2"]] as const) {
      const s = await server(repo);
      try {
        const brain = new ModelBrain({ name: "laya", url: s.url, model: "typed-decisions" }, "composite", "melee");
        expect(await brain.meleeDescribe()).toBe(want);
      } finally {
        s.close();
      }
    }
  });
});
