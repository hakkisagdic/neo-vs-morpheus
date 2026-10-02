// MCP server for the fleet: every machine that plays matches (fleet.json), one set of tools for an
// assistant to see them, gather their runs and start or stop series. Runs on stdio:
//   node bot/src/fleet/mcp.ts          (.mcp.json at the repo root registers it)
// Nothing may go to stdout but the protocol, so the fleet's own output only travels in tool results.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type Instance, loadFleet, pick } from "./instances.ts";
import { formatRows, readRuns, tally } from "./results.ts";

const server = new McpServer({ name: "laya-fleet", version: "0.1.0" });

type Answer = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string, isError = false): Answer => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

/** Runs one step on each chosen instance; one failing machine does not hide the others' answers. */
async function each(instance: string | undefined, step: (i: Instance) => Promise<string>): Promise<Answer> {
  try {
    const fleet = pick(await loadFleet(), instance);
    const parts = await Promise.all(
      fleet.map(async (i) => {
        try {
          return { ok: true, text: `## ${i.name}\n${await step(i)}` };
        } catch (err) {
          return { ok: false, text: `## ${i.name}\nerror: ${(err as Error).message}` };
        }
      }),
    );
    return text(parts.map((p) => p.text).join("\n\n"), parts.every((p) => !p.ok));
  } catch (err) {
    return text((err as Error).message, true);
  }
}

const instanceArg = z.string().optional().describe("one instance from fleet.json; all of them when left out");

server.registerTool(
  "fleet_setup",
  {
    title: "Set up a VM",
    description:
      "Make a fresh GPU VM ready to play: ModernUO with the arena overlay, Node and the bot, at GitHub's main plus this checkout's unpushed and uncommitted changes. Runs in the background; fleet_status shows its progress.",
    inputSchema: { instance: z.string() },
  },
  async ({ instance }) => each(instance, (i) => i.setup()),
);

server.registerTool(
  "fleet_status",
  {
    title: "Fleet status",
    description: "What every machine is doing: load and GPU, each lane's series and model, entries done and the last result.",
    inputSchema: { instance: instanceArg },
    annotations: { readOnlyHint: true },
  },
  async ({ instance }) => each(instance, (i) => i.status()),
);

server.registerTool(
  "fleet_pull",
  {
    title: "Pull runs",
    description: "Bring new run files from the machines into runs/ on this Mac (as <instance>--<stamp>.json).",
    inputSchema: { instance: instanceArg },
  },
  async ({ instance }) => each(instance, (i) => i.pull()),
);

server.registerTool(
  "fleet_results",
  {
    title: "Results",
    description:
      "Round wins by matchup over the runs in runs/ (pull first). A side reads as its checkpoint or rules@<reaction ms>, then its template and tactics. Runs a run check flagged are left out unless asked for.",
    inputSchema: {
      since: z.string().optional().describe("only runs started at or after this time (ISO 8601, e.g. 2026-10-01T21:00Z)"),
      instance: z.string().optional().describe("only runs played on this instance"),
      includeFlagged: z.boolean().optional().describe("count runs the run checks flagged"),
      byArena: z.boolean().optional().describe("one row per arena layout and distance"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ since, instance, includeFlagged, byArena }) => {
    const from = since ? Date.parse(since) : undefined;
    if (since && !Number.isFinite(from)) {
      return text(`cannot read the time ${since}`, true);
    }
    return text(formatRows(tally(await readRuns(), { since: from, instance, includeFlagged, byArena })));
  },
);

server.registerTool(
  "fleet_start",
  {
    title: "Start a series",
    description:
      "Start a series file (a JSON list of matches, e.g. lab/series-mage12.json) on one lane of an instance. On a GPU instance `model` picks the Laya checkpoint (a tag in the models repo) for that lane.",
    inputSchema: {
      instance: z.string(),
      series: z.string().describe("path to the series file, from the repo root"),
      lane: z.number().int().min(0).max(7).optional().describe("lane (arena server) number, default 0"),
      parallel: z.number().int().min(1).max(8).optional().describe("arenas at once, default 8"),
      model: z.string().optional().describe("Laya checkpoint tag for the lane, e.g. neo-duel-v8-dagger-all"),
    },
  },
  async ({ instance, ...o }) => each(instance, (i) => i.start(o)),
);

server.registerTool(
  "fleet_stop",
  {
    title: "Stop series",
    description: "Stop the series on one lane, or on every lane of the instance.",
    inputSchema: { instance: z.string(), lane: z.number().int().min(0).max(7).optional() },
    annotations: { destructiveHint: true },
  },
  async ({ instance, lane }) => each(instance, (i) => i.stop(lane)),
);

server.registerTool(
  "fleet_logs",
  {
    title: "Lane log",
    description: "The last lines a lane's series printed.",
    inputSchema: {
      instance: z.string(),
      lane: z.number().int().min(0).max(7).optional(),
      lines: z.number().int().min(1).max(500).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ instance, lane, lines }) => each(instance, (i) => i.logs(lane, lines)),
);

await server.connect(new StdioServerTransport());
