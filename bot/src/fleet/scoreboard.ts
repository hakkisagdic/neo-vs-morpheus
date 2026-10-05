// The panel's model scoreboard, from rows of round wins by matchup (results.ts): each checkpoint,
// with each tactics profile it played, against the scripted bot at matched speed, one column per
// build. What does not measure a checkpoint (exploration's random moves, the scripted bot against
// itself, NPCs) is counted apart as data collection.
import type { Row } from "./results.ts";

/** The scripted bot at this reaction time or quicker plays at Laya's own speed. */
export const MATCHED_MS = 60;

export type Cell = { wins: number; losses: number; draws: number; runs: number; flagged: number };
export type ScoreRow = { model: string; tactics?: string; cells: Record<string, Cell> };
export type Collection = { kind: "exploration" | "scripted" | "other"; runs: number; rounds: number; flagged: number; models: string[] };
export type Scoreboard = { columns: string[]; rows: ScoreRow[]; collection: Collection[] };

type Side = { who: string; template: string; tactics?: string };

/** "neo-duel-v8 mage heal-first", "rules@40 dexer", "laya (model not recorded) mage explore". */
export function parseSide(side: string): Side {
  const m = /^(\S+(?: \(model not recorded\))?) (\S+)(?: (.+))?$/.exec(side);
  return m ? { who: m[1], template: m[2], tactics: m[3] } : { who: side, template: "" };
}

const scripted = (s: Side) => /^rules@\d+$/.test(s.who);
const isModel = (s: Side) => !scripted(s) && !["npc", "human"].includes(s.who);
const speed = (s: Side) => Number(s.who.slice("rules@".length));
const BUILDS = ["mage", "dexer", "archer"];

export function scoreboard(rows: Row[]): Scoreboard {
  const board = new Map<string, ScoreRow>();
  const collection = new Map<Collection["kind"], Collection>();
  const collect = (kind: Collection["kind"], r: Row, model?: string) => {
    const c = collection.get(kind) ?? { kind, runs: 0, rounds: 0, flagged: 0, models: [] };
    collection.set(kind, c);
    c.runs += r.runs;
    c.rounds += r.wins[0] + r.wins[1] + r.draws;
    c.flagged += r.flagged;
    // A model is named for what it played, not for runs the checks left out.
    if (model && r.runs > 0 && !c.models.includes(model)) c.models.push(model);
  };
  for (const r of rows) {
    const [a, b] = r.sides.map(parseSide);
    const i = isModel(a) && scripted(b) ? 0 : isModel(b) && scripted(a) ? 1 : -1;
    if (i < 0) {
      collect(scripted(a) && scripted(b) ? "scripted" : "other", r);
      continue;
    }
    const [me, them] = i === 0 ? [a, b] : [b, a];
    if (me.tactics?.split(" ").includes("explore")) {
      collect("exploration", r, me.who);
      continue;
    }
    if (them.tactics || speed(them) > MATCHED_MS) {
      collect("other", r, me.who);
      continue;
    }
    const key = `${me.who}|${me.tactics ?? ""}`;
    const row = board.get(key) ?? { model: me.who, ...(me.tactics ? { tactics: me.tactics } : {}), cells: {} };
    board.set(key, row);
    const column = me.template === them.template ? me.template : `${me.template} vs ${them.template}`;
    const cell = (row.cells[column] ??= { wins: 0, losses: 0, draws: 0, runs: 0, flagged: 0 });
    cell.wins += r.wins[i];
    cell.losses += r.wins[1 - i];
    cell.draws += r.draws;
    cell.runs += r.runs;
    cell.flagged += r.flagged;
  }
  // A row with no counted run (every one flagged) measures nothing: its runs count as left out.
  const measured = [...board.values()].filter((row) => Object.values(row.cells).some((c) => c.runs > 0));
  for (const row of [...board.values()].filter((row) => !measured.includes(row))) {
    const c = collection.get("other") ?? { kind: "other" as const, runs: 0, rounds: 0, flagged: 0, models: [] };
    collection.set("other", c);
    c.flagged += Object.values(row.cells).reduce((n, cell) => n + cell.flagged, 0);
  }
  const columns = [...new Set(measured.flatMap((row) => Object.keys(row.cells)))].sort(
    (x, y) => (BUILDS.indexOf(x) + 1 || 99) - (BUILDS.indexOf(y) + 1 || 99) || x.localeCompare(y),
  );
  // The newest checkpoint first (v9b before v9a before v8), its own play before its profiles.
  const unknown = (row: ScoreRow) => (row.model.includes("(model not recorded)") ? 1 : 0);
  measured.sort(
    (x, y) => unknown(x) - unknown(y) || y.model.localeCompare(x.model, undefined, { numeric: true }) || (x.tactics ?? "").localeCompare(y.tactics ?? ""),
  );
  const kinds: Collection["kind"][] = ["exploration", "scripted", "other"];
  return { columns, rows: measured, collection: kinds.flatMap((k) => collection.get(k) ?? []) };
}
