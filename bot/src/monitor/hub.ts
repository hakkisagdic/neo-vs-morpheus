// Duel monitor: serves the page and streams every bot's decisions and live state over WebSocket.
import { readFile } from "node:fs/promises";
import http from "node:http";
import { extname, join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { DecisionRecord, DuelController } from "../game/duel.ts";

export type RoundResult = {
  round: number;
  winner: string | null;
  loser: string | null;
  reason: string;
  durationMs: number;
  healthPct: Record<string, number>;
};

export type MatchInfo = {
  title: string;
  fighters: { name: string; brain: string; template?: string }[];
  round: number;
  rounds: number;
  results: RoundResult[];
  startedAt: number;
};

const PUBLIC = join(import.meta.dirname, "public");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const KEEP_DECISIONS = 300;

/** Only what the page shows, to keep frames small. */
function slim(r: DecisionRecord) {
  const d = r.decision;
  return {
    id: r.id,
    at: r.at,
    bot: r.bot,
    opponent: r.opponent,
    brain: d.brain,
    model: d.model,
    latencyMs: Math.round(d.latencyMs * 10) / 10,
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    module: d.module,
    mode: d.mode,
    parts: d.parts,
    tile: d.tile,
    plan: d.plan,
    why: d.why,
    overrides: d.overrides,
    target: r.snapshot.them.serial,
    outcome: r.outcome,
  };
}

export class MonitorHub {
  readonly #clients = new Set<WebSocket>();
  readonly #controllers = new Map<string, DuelController>();
  readonly #decisions: ReturnType<typeof slim>[] = [];
  readonly #log: { at: number; bot: string; text: string }[] = [];
  #match: MatchInfo | null = null;
  #timer: NodeJS.Timeout | null = null;
  #server: http.Server | null = null;

  /** Listens on `port`, or the next free one when something else already holds it. */
  async start(port: number): Promise<string> {
    const server = http.createServer((req, res) => void this.#serve(req, res));
    let bound = port;
    for (; bound < port + 10; bound++) {
      const ok = await new Promise<boolean>((resolve) => {
        server.once("error", () => resolve(false));
        server.listen(bound, "127.0.0.1", () => resolve(true));
      });
      if (ok) {
        break;
      }
    }
    if (!server.listening) {
      throw new Error(`no free port for the monitor in ${port}..${port + 9}`);
    }
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (ws) => {
      this.#clients.add(ws);
      ws.on("close", () => this.#clients.delete(ws));
      ws.send(JSON.stringify({ type: "hello", match: this.#match, decisions: this.#decisions, log: this.#log }));
    });
    this.#server = server;
    this.#timer = setInterval(() => this.#broadcastLive(), 200);
    return `http://localhost:${bound}`;
  }

  async #serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = req.url === "/" || !req.url ? "/index.html" : req.url.split("?")[0];
    const type = TYPES[extname(path)];
    if (!type || path.includes("..")) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(join(PUBLIC, path));
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  }

  attach(controller: DuelController): void {
    this.#controllers.set(controller.name, controller);
    controller.on("decision", (r) => this.#push("decision", slim(r)));
    controller.on("outcome", (r) => this.#push("outcome", slim(r)));
    controller.on("log", (text) => {
      const entry = { at: Date.now(), bot: controller.name, text };
      this.#log.push(entry);
      if (this.#log.length > 200) {
        this.#log.shift();
      }
      this.#broadcast({ type: "log", ...entry });
    });
  }

  detachAll(): void {
    for (const c of this.#controllers.values()) {
      c.removeAllListeners("decision");
      c.removeAllListeners("outcome");
      c.removeAllListeners("log");
    }
    this.#controllers.clear();
  }

  setMatch(match: MatchInfo): void {
    this.#match = match;
    this.#broadcast({ type: "match", match });
  }

  #push(type: "decision" | "outcome", record: ReturnType<typeof slim>): void {
    if (type === "decision") {
      this.#decisions.push(record);
      if (this.#decisions.length > KEEP_DECISIONS) {
        this.#decisions.shift();
      }
    } else {
      const i = this.#decisions.findLastIndex((d) => d.bot === record.bot && d.id === record.id);
      if (i >= 0) {
        this.#decisions[i] = record;
      }
    }
    this.#broadcast({ type, record });
  }

  #broadcastLive(): void {
    if (this.#clients.size === 0 || this.#controllers.size === 0) {
      return;
    }
    const bots: Record<string, unknown> = {};
    for (const [name, c] of this.#controllers) {
      const s = c.snapshot();
      bots[name] = {
        us: s.us,
        them: s.them,
        casting: c.caster.current ? { spell: c.caster.current.spell.name, since: c.caster.current.since } : null,
        readyAt: c.caster.readyAt,
      };
    }
    this.#broadcast({ type: "live", at: Date.now(), bots });
  }

  #broadcast(message: unknown): void {
    const frame = JSON.stringify(message);
    for (const ws of this.#clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
    }
    for (const ws of this.#clients) {
      ws.close();
    }
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }
}
