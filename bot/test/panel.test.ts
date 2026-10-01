import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { MonitorHub } from "../src/monitor/hub.ts";
import { PanelServer, summarise } from "../src/panel/server.ts";

type Client = { ws: WebSocket; next: (type: string) => Promise<Record<string, unknown>>; close: () => void };

/** A client that queues every message from the start, so none slips by before a test waits for it. */
const open = (url: string, origin?: string) =>
  new Promise<Client>((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const queue: Record<string, unknown>[] = [];
    const waiting: { type: string; resolve: (m: Record<string, unknown>) => void }[] = [];
    ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      const i = waiting.findIndex((w) => w.type === m.type);
      if (i >= 0) {
        waiting.splice(i, 1)[0].resolve(m);
      } else {
        queue.push(m);
      }
    });
    const next = (type: string) =>
      new Promise<Record<string, unknown>>((res) => {
        const i = queue.findIndex((m) => m.type === type);
        if (i >= 0) {
          res(queue.splice(i, 1)[0]);
        } else {
          waiting.push({ type, resolve: res });
        }
      });
    ws.once("open", () => resolve({ ws, next, close: () => ws.close() }));
    ws.once("error", reject);
    ws.once("unexpected-response", () => reject(new Error("refused")));
  });

let panel: PanelServer | null = null;
afterEach(async () => {
  await panel?.stop();
  panel = null;
});

describe("the control panel", () => {
  it("relays a duel's frames to pages, and a page's tactics back to that duel", async () => {
    panel = new PanelServer();
    const url = (await panel.start(0)).replace("http", "ws");
    const page = await open(`${url}/ws`);
    const hello = await page.next("hello");
    expect(hello.sources).toEqual([]);

    const duel = await open(`${url}/publish`);
    const source = (await page.next("source")).source as string;
    duel.ws.send(JSON.stringify({ type: "match", match: { title: "Neo vs Morpheus" } }));
    const match = await page.next("match");
    expect(match).toMatchObject({ source, match: { title: "Neo vs Morpheus" } });

    // A page that opens mid-match picks it up.
    duel.ws.send(JSON.stringify({ type: "decision", record: { bot: "Neo", id: 1 } }));
    await page.next("decision");
    const late = await open(`${url}/ws`);
    expect(((await late.next("hello")).sources as unknown[])[0]).toMatchObject({ id: source, match: { title: "Neo vs Morpheus" }, decisions: [{ bot: "Neo", id: 1 }] });

    const tactics = duel.next("tactics");
    page.ws.send(JSON.stringify({ type: "tactics", source, bot: "Neo", tactics: { id: "balanced", kite: 6 } }));
    expect(await tactics).toMatchObject({ bot: "Neo", tactics: { kite: 6 } });

    duel.close();
    expect((await page.next("gone")).source).toBe(source);
    page.close();
    late.close();
  });

  it("takes a duel's monitor as a publisher; without a panel the monitor serves its own page", async () => {
    panel = new PanelServer();
    const base = await panel.start(0);
    const port = Number(new URL(base).port);
    const page = await open(`${base.replace("http", "ws")}/ws`);
    const hub = new MonitorHub();
    expect(await hub.start(port)).toMatch(/control panel/);
    await page.next("source");
    hub.setMatch({ title: "Neo vs Morpheus", fighters: [], round: 1, rounds: 3, results: [], startedAt: 0 });
    expect(await page.next("match")).toMatchObject({ match: { title: "Neo vs Morpheus" } });
    await hub.stop();
    page.close();
    await panel.stop();
    panel = null;

    const alone = new MonitorHub();
    const own = await alone.start(port);
    expect(own).not.toMatch(/control panel/);
    await alone.stop();
  });

  it("lets no web page publish or watch from another site", async () => {
    panel = new PanelServer();
    const url = (await panel.start(0)).replace("http", "ws");
    await expect(open(`${url}/publish`, "http://localhost:9999")).rejects.toThrow();
    await expect(open(`${url}/ws`, "https://evil.example")).rejects.toThrow();
    const own = await open(`${url}/ws`, url.replace("ws", "http"));
    own.close();
  });

  it("summarises a run with its score and checks", () => {
    const decision = (latencyMs: number) => ({ brain: "laya", latencyMs, plan: { kind: "wait", ms: 300 } });
    const summary = summarise("r.json", {
      match: {
        title: "Neo (laya) vs Morpheus (rules)",
        fighters: [{ name: "Neo", brain: "laya" }, { name: "Morpheus", brain: "rules" }],
        rounds: 3,
        startedAt: 1,
        results: [{ winner: "Neo", durationMs: 30_000 }, { winner: null, durationMs: 120_000 }, { winner: "Morpheus", durationMs: 30_000 }],
      },
      records: [1, 2, 3].map((i) => ({ bot: "Neo", decision: decision(900), outcome: undefined, snapshot: { us: {} } })) as never,
    });
    expect(summary).toMatchObject({ wins: { Neo: 1, Morpheus: 1 }, draws: 1, avgRoundS: 60, latencyMs: { Neo: 900 } });
    expect(summary.problems[0]).toMatch(/900 ms per decision/);
  });
});
