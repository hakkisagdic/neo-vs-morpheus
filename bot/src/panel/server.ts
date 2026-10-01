// The control panel: one page for live matches, recorded runs and their replays, served by a
// process that stays up between matches (`npm run nvm -- panel`).
//
// Duel processes publish to it over a WebSocket (/publish) and it relays everything to the open
// pages (/ws); a tactics change made on a page goes back to the duel that owns the bot. Several
// duels can publish at once (parallel arenas), each as its own source. Without a panel running a
// duel serves its own page, as before (monitor/hub.ts).
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { checkRun } from "../eval/run-checks.ts";

const PUBLIC = join(import.meta.dirname, "public");
const RUNS = join(import.meta.dirname, "..", "..", "..", "runs");
const MACHINE_REPORT = join(process.env.HOME ?? "", ".claude", "scripts", "machine-resources.sh");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};
const KEEP_DECISIONS = 300;
const KEEP_LOG = 200;

/** What a page needs to pick up a match that is already running. */
type Source = {
  id: string;
  publisher: WebSocket;
  match: unknown;
  decisions: { bot: string; id: number }[];
  log: unknown[];
  since: number;
};

/** One recorded run, as the runs page lists it. */
export type RunSummary = {
  file: string;
  startedAt: number;
  title: string;
  fighters: { name: string; brain: string; template?: string; tactics?: string }[];
  rounds: number;
  wins: Record<string, number>;
  draws: number;
  avgRoundS: number;
  arena?: string;
  distance?: number;
  versions?: Record<string, unknown>;
  problems: string[];
  latencyMs: Record<string, number>;
};

type RunFile = {
  versions?: Record<string, unknown>;
  match: {
    title: string;
    fighters: RunSummary["fighters"];
    rounds: number;
    startedAt: number;
    arena?: string;
    distance?: number;
    results: { winner: string | null; durationMs: number }[];
  };
  records: Parameters<typeof checkRun>[0];
};

export function summarise(file: string, run: RunFile): RunSummary {
  const wins: Record<string, number> = {};
  let draws = 0;
  for (const r of run.match.results) {
    if (r.winner) {
      wins[r.winner] = (wins[r.winner] ?? 0) + 1;
    } else {
      draws++;
    }
  }
  const checks = checkRun(run.records ?? []);
  const total = run.match.results.reduce((s, r) => s + r.durationMs, 0);
  return {
    file,
    startedAt: run.match.startedAt,
    title: run.match.title,
    fighters: run.match.fighters,
    rounds: run.match.results.length,
    wins,
    draws,
    avgRoundS: run.match.results.length ? Math.round(total / run.match.results.length / 1000) : 0,
    arena: run.match.arena,
    distance: run.match.distance,
    versions: run.versions,
    problems: checks.flatMap((c) => c.problems),
    latencyMs: Object.fromEntries(checks.map((c) => [c.bot, c.latencyMs])),
  };
}

export class PanelServer {
  readonly #pages = new Set<WebSocket>();
  readonly #sources = new Map<string, Source>();
  readonly #summaries = new Map<string, { mtimeMs: number; summary: RunSummary | null }>();
  #server: http.Server | null = null;
  #nextSource = 1;

  /** Listens on `port` (0: any free one) and returns the panel's address. */
  async start(port: number): Promise<string> {
    const server = http.createServer((req, res) => void this.#serve(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    const bound = (server.address() as AddressInfo).port;
    const pages = new WebSocketServer({ noServer: true });
    const publishers = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0];
      const origin = req.headers.origin;
      if (path === "/ws") {
        // Pages can change a bot's tactics, so only the panel's own page may connect: a browser
        // lets any site open a WebSocket to localhost, but it sends the site's origin.
        if (origin && origin !== `http://localhost:${bound}` && origin !== `http://127.0.0.1:${bound}`) {
          socket.destroy();
          return;
        }
        pages.handleUpgrade(req, socket, head, (ws) => this.#page(ws));
      } else if (path === "/publish" && !origin) {
        // Duel processes are not browsers and send no origin; a web page always does.
        publishers.handleUpgrade(req, socket, head, (ws) => this.#publisher(ws));
      } else {
        socket.destroy();
      }
    });
    this.#server = server;
    return `http://localhost:${bound}`;
  }

  #page(ws: WebSocket): void {
    this.#pages.add(ws);
    ws.on("close", () => this.#pages.delete(ws));
    ws.on("message", (data) => {
      let message: { type?: string; source?: string };
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      // A tactics change goes to the duel that runs the bot.
      const source = message.source ? this.#sources.get(message.source) : undefined;
      if (message.type === "tactics" && source?.publisher.readyState === WebSocket.OPEN) {
        source.publisher.send(String(data));
      }
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        sources: [...this.#sources.values()].map(({ publisher: _p, ...s }) => s),
      }),
    );
  }

  #publisher(ws: WebSocket): void {
    const source: Source = { id: `s${this.#nextSource++}`, publisher: ws, match: null, decisions: [], log: [], since: Date.now() };
    this.#sources.set(source.id, source);
    ws.on("message", (data) => {
      let message: { type?: string; record?: { bot: string; id: number }; match?: unknown };
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      switch (message.type) {
        case "match":
          source.match = message.match;
          break;
        case "decision":
          if (message.record) {
            source.decisions.push(message.record);
            if (source.decisions.length > KEEP_DECISIONS) {
              source.decisions.shift();
            }
          }
          break;
        case "outcome": {
          const r = message.record;
          const i = r ? source.decisions.findLastIndex((d) => d.bot === r.bot && d.id === r.id) : -1;
          if (r && i >= 0) {
            source.decisions[i] = r;
          }
          break;
        }
        case "log":
          source.log.push(message);
          if (source.log.length > KEEP_LOG) {
            source.log.shift();
          }
          break;
      }
      this.#broadcast({ ...message, source: source.id });
    });
    ws.on("close", () => {
      this.#sources.delete(source.id);
      this.#broadcast({ type: "gone", source: source.id });
    });
    this.#broadcast({ type: "source", source: source.id, since: source.since });
  }

  #broadcast(message: unknown): void {
    const frame = JSON.stringify(message);
    for (const ws of this.#pages) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    }
  }

  async #serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    try {
      if (path === "/api/runs") {
        return json(res, await this.#runs());
      }
      if (path.startsWith("/api/runs/")) {
        const file = path.slice("/api/runs/".length);
        if (!/^[\w.-]+\.json$/.test(file)) {
          return void res.writeHead(400).end();
        }
        res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" });
        return void res.end(await readFile(join(RUNS, file)));
      }
      if (path === "/api/machine") {
        return json(res, { report: await machineReport() });
      }
      const file = path === "/" ? "/index.html" : path;
      const type = TYPES[extname(file)];
      if (!type || file.includes("..")) {
        return void res.writeHead(404).end();
      }
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(await readFile(join(PUBLIC, file)));
    } catch {
      if (!res.headersSent) {
        res.writeHead(404);
      }
      res.end();
    }
  }

  /** Every run's summary, newest first; a file is read again only when it changed. */
  async #runs(): Promise<RunSummary[]> {
    const files = (await readdir(RUNS)).filter((f) => f.endsWith(".json"));
    const out: RunSummary[] = [];
    for (const file of files) {
      const { mtimeMs } = await stat(join(RUNS, file));
      let cached = this.#summaries.get(file);
      if (!cached || cached.mtimeMs !== mtimeMs) {
        let summary: RunSummary | null = null;
        try {
          summary = summarise(file, JSON.parse(await readFile(join(RUNS, file), "utf8")) as RunFile);
        } catch {
          // A run being written, or an old layout: left out.
        }
        cached = { mtimeMs, summary };
        this.#summaries.set(file, cached);
      }
      if (cached.summary) {
        out.push(cached.summary);
      }
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  async stop(): Promise<void> {
    for (const ws of [...this.#pages, ...[...this.#sources.values()].map((s) => s.publisher)]) {
      ws.close();
    }
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }
}

function json(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

let machine: { at: number; text: Promise<string> } | null = null;

/** The shared machine report (memory, swap-ins, disk, claims), at most every 10 s. */
function machineReport(): Promise<string> {
  if (!machine || Date.now() - machine.at > 10_000) {
    machine = {
      at: Date.now(),
      text: new Promise((resolve) =>
        execFile(MACHINE_REPORT, ["report"], { timeout: 8_000 }, (err, stdout) => resolve(err ? `unavailable: ${err.message}` : stdout)),
      ),
    };
  }
  return machine.text;
}
