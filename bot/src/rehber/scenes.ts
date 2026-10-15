// Rehber's scenes as data: data/rehber/<category>.json (Turkish lines) and data/rehber/yerler.json
// (the places they happen). This file reads and checks them; nothing here talks to the server, so
// every rule a scene must keep is tested without one (test/rehber.test.ts). director.ts plays them.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KEYWORDS, type Keyword } from "../uo/outgoing.ts";

export const DATA = join(import.meta.dirname, "..", "..", "..", "data", "rehber");

/** The guide's own character: Neo commands that name a player may name this one only. */
export const GUIDE = "Rehber";

/** Facets by their index on the wire (0xBF 0x08) and as `[Go <name>` spells them. */
export const MAPS = ["Felucca", "Trammel", "Ilshenar", "Malas", "Tokuno", "TerMur"] as const;
export type MapName = (typeof MAPS)[number];

export type Place = { x: number; y: number; z?: number; map: MapName; about?: string };

/** The arena the agent sessions play on (NEO_ARENA_X/Y, Felucca): nothing goes near it while one runs. */
export const ARENA = { map: "Felucca" as MapName, x: 1180, y: 3610, reach: 100 };

/** Overhead speech: ModernUO drops lines over 128 characters; a short line is read in 2-3 seconds. */
export const SAY_MAX = 80;

/** Seconds a spoken line stays up before the next step: about 25 characters a second, 2 to 4.5 s. */
export const sayPause = (text: string): number => Math.min(4.5, Math.max(2, 1 + text.length / 25));

/** Public moongate destinations in the order MoongateGump lists them, per facet (PMList). */
export const MOONGATES: Partial<Record<MapName, readonly string[]>> = {
  Trammel: ["Moonglow", "Britain", "Jhelom", "Yew", "Minoc", "Trinsic", "Skara Brae", "Magincia", "New Haven"],
  Felucca: ["Moonglow", "Britain", "Jhelom", "Yew", "Minoc", "Trinsic", "Skara Brae", "Magincia", "Buccaneer's Den"],
};

/** What a target cursor gets: the guide, a creature it added (by its name in the scene), a tile beside it. */
export type Target = { kind: "self" } | { kind: "creature"; as: string } | { kind: "tile"; dx: number; dy: number };

export type Step =
  | { kind: "say"; text: string; seconds: number }
  /** confirm: answer OKAY to the confirmation the server asks before deleting several objects. */
  | { kind: "gm"; command: string; target?: Target; seconds: number; confirm?: true }
  | { kind: "go"; place: string }
  | { kind: "walk"; dx: number; dy: number; run: boolean }
  | { kind: "wait"; seconds: number }
  | { kind: "add"; type: string; dx: number; dy: number; set: Record<string, string>; as: string }
  | { kind: "war"; on: boolean }
  | { kind: "attack"; as: string; seconds: number }
  | { kind: "bandage"; seconds: number }
  | { kind: "speak"; keyword: Keyword }
  | { kind: "buy"; item: string; graphic: number; amount: number; vendor: string }
  | { kind: "moongate"; to: string }
  | { kind: "cleanup" };

export type Scene = {
  id: string;
  title: string;
  /** Where it starts: a place in yerler.json. */
  start: string;
  /** "no-session": it acts at the arena, so it plays only while no agent session runs. */
  needs?: "no-session";
  steps: Step[];
};

export type Category = { id: string; title: string; about: string; scenes: Scene[] };

/** The action keys a step may have (exactly one; `wait` beside `say` or `gm` is a pause instead). */
const ACTIONS = ["say", "gm", "go", "walk", "wait", "add", "war", "attack", "bandage", "speak", "buy", "moongate", "cleanup"] as const;
/** Keys a step may carry besides its action. */
const MODIFIERS: Record<string, readonly string[]> = {
  say: ["wait"],
  gm: ["wait", "target", "confirm"],
  walk: ["run"],
  add: ["at", "set", "as"],
  attack: ["max"],
  bandage: ["max"],
  buy: ["graphic", "amount", "from"],
};

/** Neo commands that act around the arena's centre (server/overlay/NeoArena.cs). */
const ARENA_COMMANDS = ["neoplace", "neoduel", "neomage", "neospawn", "neoclear", "neoarena"];
/** Neo commands whose first argument names a player. */
const NAMING_COMMANDS = ["neoprep", "neotemplate", "neoplace"];
/**
 * The commands a scene may say. Every scope is a GameMaster's (ModernUO: [Global is an Administrator's),
 * and what changes or deletes things does so only to the guide or to creatures the scene added.
 * Creatures come from add steps (so that they are cleaned up) and the guide travels with go steps (so
 * that it never comes near the arena while a session runs): [Add and a [Go to coordinates are not here.
 * [NeoDuel would name a second player.
 */
const ALLOWED = new Set(["where", "go", "tele", "teleport", "props", "self", "serial", "range", "facet", "hide", "unhide",
  "neoprep", "neotemplate", ...ARENA_COMMANDS.filter((c) => c !== "neoduel")]);
/** Properties no scene sets: where anything stands, and (on the guide) who it is. */
const NOWHERE = new Set(["map", "location", "x", "y", "z"]);
const WHO = new Set(["accesslevel", "name", "account", "player"]);

const slug = /^[a-z0-9][a-z0-9-]*$/;
const placeholder = /\{([a-z0-9-]+)\}/g;

/** A command's words, lower case, without the leading "[". */
const words = (command: string) => command.slice(1).trim().split(/\s+/).map((w) => w.toLowerCase());

/** Whether a GM command acts at the arena (and so must wait for no session to run). */
export const isArenaCommand = (command: string): boolean => ARENA_COMMANDS.includes(words(command)[0] ?? "");

/** Whether a place lies within reach of the arena, on its facet. */
export const nearArena = (p: Place): boolean =>
  p.map === ARENA.map && Math.max(Math.abs(p.x - ARENA.x), Math.abs(p.y - ARENA.y)) <= ARENA.reach;

/** `[Add <type> set CantWalk true ...`: every creature a scene adds stays where it was put (and is marked so). */
export function addCommand(type: string, set: Record<string, string>): string {
  const props = { CantWalk: "true", ...set };
  const value = (v: string) => (/\s/.test(v) ? `"${v}"` : v);
  return `[Add ${type} set ${Object.entries(props).map(([k, v]) => `${k} ${value(v)}`).join(" ")}`;
}

/** The commands that take the guide to a place: `[Go <facet>` when it is elsewhere, then `[Go x y [z]`. */
export function goCommands(p: Place, currentMap: number): string[] {
  const there = `[Go ${p.x} ${p.y}${p.z === undefined ? "" : ` ${p.z}`}`;
  return MAPS[currentMap] === p.map ? [there] : [`[Go ${p.map}`, there];
}

/** A scene's length, roughly: its lines, pauses and the fixed costs of what it does. */
export function sceneSeconds(scene: Scene): number {
  const cost: Record<Step["kind"], (s: Step) => number> = {
    say: (s) => (s as { seconds: number }).seconds,
    gm: (s) => Math.min(3, (s as { seconds: number }).seconds),
    go: () => 2,
    walk: (s) => Math.max(Math.abs((s as { dx: number }).dx), Math.abs((s as { dy: number }).dy)) * 0.4,
    wait: (s) => (s as { seconds: number }).seconds,
    add: () => 2,
    war: () => 1,
    attack: () => 10,
    bandage: () => 9,
    speak: () => 2,
    buy: () => 6,
    moongate: () => 5,
    cleanup: () => 2,
  };
  return Math.round(scene.steps.reduce((sum, s) => sum + cost[s.kind](s), 2));
}

type Context = { scene: string; needsNoSession: boolean; places: Record<string, Place>; creatures: ReadonlySet<string>; aliases: Set<string> };

const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isNum = (v: unknown, min: number, max: number): v is number => typeof v === "number" && v >= min && v <= max;
const pair = (v: unknown, reach: number): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((d) => isInt(d, -reach, reach));

/** The problems with one GM command in a scene; none when it is fine. */
export function commandProblems(command: string, ctx: Pick<Context, "needsNoSession" | "aliases" | "creatures">): string[] {
  if (!command.startsWith("[") || command.length < 2) {
    return [`"${command}" is not a GM command (they start with "[")`];
  }
  const problems: string[] = [];
  for (const [, alias] of command.matchAll(placeholder)) {
    if (!ctx.aliases.has(alias)) {
      problems.push(`"${command}" names {${alias}}, which no earlier add step made`);
    }
  }
  const w = words(command);
  const [head, ...rest] = w;
  if (head === "global") {
    return [`"${command}": [Global is an Administrator's; the guide is a GameMaster (use [Range or [Facet)`];
  }
  if (head === "add") {
    return [`"${command}": creatures come from add steps, which clean them up afterwards`];
  }
  if (!ALLOWED.has(head)) {
    return [...problems, `"${command}": [${head} is not among the commands a scene may say`];
  }
  if (ARENA_COMMANDS.includes(head) && !ctx.needsNoSession) {
    problems.push(`"${command}" acts at the arena: the scene needs "no-session"`);
  }
  if (NAMING_COMMANDS.includes(head) && rest[0] !== GUIDE.toLowerCase()) {
    problems.push(`"${command}" names a player; a scene may name only ${GUIDE}`);
  }
  if (head === "go" && !(rest.length === 1 && /^\{[a-z0-9-]+\}$/.test(rest[0]))) {
    problems.push(`"${command}": [Go here goes to a creature the scene added ({name}); places are go steps`);
  }
  if (head === "facet" && rest[0] !== "count") {
    problems.push(`"${command}": over a whole facet a scene may only count`);
  }
  if (head === "self" && !["set", "hide", "unhide"].includes(rest[0] ?? "")) {
    problems.push(`"${command}": [Self takes Set, Hide or Unhide here`);
  }
  if (head === "serial" && (!/^\{[a-z0-9-]+\}$/.test(command.split(/\s+/)[1] ?? "") || !["set", "delete", "props"].includes(rest[1] ?? ""))) {
    problems.push(`"${command}": [Serial takes a creature the scene added ({name}) and Set, Delete or Props`);
  }
  if (head === "range") {
    const range = Number(rest[0]);
    const verb = rest[1];
    if (!Number.isInteger(range) || range < 1 || range > 12) {
      problems.push(`"${command}": a range of 1 to 12 tiles`);
    }
    if (!["count", "set", "delete"].includes(verb ?? "")) {
      problems.push(`"${command}": [Range takes Count, Set or Delete here`);
    }
    if (verb === "set" || verb === "delete") {
      // Only the scene's own creatures: a creature's type, and the mark every added creature carries.
      const where = rest.indexOf("where");
      const type = where >= 0 ? rest[where + 1] : undefined;
      const known = [...ctx.creatures].some((c) => c.toLowerCase() === type);
      if (!known || !/cantwalk\s*=\s*true/.test(rest.slice(where).join(" "))) {
        problems.push(`"${command}": a Set or Delete over a range needs "where <creature type> CantWalk = true" (the scene's creatures)`);
      }
    }
  }
  // A Set changes neither who the guide is nor where anything stands.
  const set = w.indexOf("set");
  if (set >= 0 && ["self", "serial", "range"].includes(head)) {
    const end = w.indexOf("where") >= 0 ? w.indexOf("where") : w.length;
    const props = w.slice(set + 1, end).filter((_, i) => i % 2 === 0);
    for (const p of props.filter((p) => NOWHERE.has(p) || (head === "self" && WHO.has(p)))) {
      problems.push(`"${command}": a scene does not set ${p}${head === "self" ? " on the guide" : ""}`);
    }
  }
  return problems;
}

/** Parses one step; a string when it is not a valid step. */
export function parseStep(raw: unknown, ctx: Context): Step | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "a step is an object";
  }
  const step = raw as Record<string, unknown>;
  const keys = Object.keys(step);
  const actions = keys.filter((k) => (ACTIONS as readonly string[]).includes(k) && !(k === "wait" && ("say" in step || "gm" in step)));
  if (actions.length !== 1) {
    return `a step has one action (${ACTIONS.join(", ")}), this one has ${actions.length ? actions.join(" and ") : "none"}`;
  }
  const action = actions[0];
  const extra = keys.filter((k) => k !== action && !(MODIFIERS[action] ?? []).includes(k));
  if (extra.length) {
    return `${action}: unknown ${extra.join(", ")}`;
  }
  const v = step[action];
  const wait = step.wait;
  if (action !== "wait" && wait !== undefined && !isNum(wait, 0, 30)) {
    return `${action}: wait is 0 to 30 seconds`;
  }
  switch (action) {
    case "say": {
      if (typeof v !== "string" || !v.trim()) {
        return "say: a line of text";
      }
      if (v.length > SAY_MAX) {
        return `say: "${v}" is ${v.length} characters; at most ${SAY_MAX} read overhead`;
      }
      if (v.trim().startsWith("[")) {
        return `say: "${v}" would be a GM command; use gm`;
      }
      return { kind: "say", text: v, seconds: (wait as number | undefined) ?? sayPause(v) };
    }
    case "gm": {
      if (typeof v !== "string") {
        return "gm: a command";
      }
      const problems = commandProblems(v, ctx);
      if (problems.length) {
        return problems.join("; ");
      }
      let target: Target | undefined;
      const t = step.target;
      if (t === "self") {
        target = { kind: "self" };
      } else if (typeof t === "string") {
        if (!ctx.aliases.has(t)) {
          return `gm: target ${t} is no creature an earlier add step made`;
        }
        target = { kind: "creature", as: t };
      } else if (pair(t, 8)) {
        target = { kind: "tile", dx: t[0], dy: t[1] };
      } else if (t !== undefined) {
        return `gm: target is "self", a creature's name or [dx, dy] within 8 tiles`;
      }
      if (step.confirm !== undefined && (step.confirm !== true || !/^\[range\s+\d+\s+delete\b/i.test(v))) {
        return "gm: confirm is true, and only for a [Range ... Delete (the server asks before deleting several)";
      }
      return { kind: "gm", command: v, ...(target ? { target } : {}), seconds: (wait as number | undefined) ?? 3, ...(step.confirm ? { confirm: true as const } : {}) };
    }
    case "go": {
      if (typeof v !== "string" || !ctx.places[v]) {
        return `go: ${String(v)} is not a place in yerler.json`;
      }
      if (nearArena(ctx.places[v]) && !ctx.needsNoSession) {
        return `go: ${v} is at the arena: the scene needs "no-session"`;
      }
      return { kind: "go", place: v };
    }
    case "walk":
      if (!pair(v, 12)) {
        return "walk: [dx, dy], at most 12 tiles each way";
      }
      if (step.run !== undefined && typeof step.run !== "boolean") {
        return "walk: run is true or false";
      }
      return { kind: "walk", dx: v[0], dy: v[1], run: step.run === true };
    case "wait":
      return isNum(v, 0.1, 30) ? { kind: "wait", seconds: v } : "wait: 0.1 to 30 seconds";
    case "add": {
      if (typeof v !== "string" || !/^[A-Za-z]+$/.test(v)) {
        return "add: a creature's type, as ModernUO names it (TimberWolf)";
      }
      if (!ctx.creatures.has(v)) {
        return `add: ${v} is not a creature in data/bestiary.json`;
      }
      const at = step.at ?? [1, 0];
      if (!pair(at, 4)) {
        return "add: at is [dx, dy] beside the guide, at most 4 tiles";
      }
      const as = step.as ?? v.toLowerCase();
      if (typeof as !== "string" || !slug.test(as)) {
        return "add: as is a short lower-case name";
      }
      if (ctx.aliases.has(as)) {
        return `add: ${as} is taken in this scene`;
      }
      const set = step.set ?? {};
      if (typeof set !== "object" || set === null || Array.isArray(set)) {
        return "add: set is {Property: value}";
      }
      const props: Record<string, string> = {};
      for (const [k, value] of Object.entries(set)) {
        if (!/^[A-Za-z]+$/.test(k) || !["string", "number", "boolean"].includes(typeof value)) {
          return `add: set ${k} needs a property name and a plain value`;
        }
        if (NOWHERE.has(k.toLowerCase())) {
          return `add: set ${k}: a creature stays where the step puts it`;
        }
        if (k.toLowerCase() === "cantwalk") {
          return "add: every added creature keeps CantWalk true, the mark range commands and the cleanup go by";
        }
        props[k] = String(value);
      }
      ctx.aliases.add(as);
      return { kind: "add", type: v, dx: at[0], dy: at[1], set: props, as };
    }
    case "war":
      return typeof v === "boolean" ? { kind: "war", on: v } : "war: true (war mode) or false (peace)";
    case "attack":
      if (typeof v !== "string" || !ctx.aliases.has(v)) {
        return `attack: ${String(v)} is no creature an earlier add step made`;
      }
      if (step.max !== undefined && !isNum(step.max, 1, 60)) {
        return "attack: max is 1 to 60 seconds";
      }
      return { kind: "attack", as: v, seconds: (step.max as number | undefined) ?? 30 };
    case "bandage":
      if (v !== "self") {
        return 'bandage: "self" (the guide heals itself)';
      }
      if (step.max !== undefined && !isNum(step.max, 1, 20)) {
        return "bandage: max is 1 to 20 seconds";
      }
      return { kind: "bandage", seconds: (step.max as number | undefined) ?? 15 };
    case "speak":
      return typeof v === "string" && v in KEYWORDS ? { kind: "speak", keyword: v as Keyword } : `speak: one of ${Object.keys(KEYWORDS).join(", ")}`;
    case "buy": {
      const graphic = typeof step.graphic === "string" ? Number.parseInt(step.graphic, 16) : step.graphic;
      if (typeof v !== "string" || !isInt(graphic, 1, 0xffff) || !isInt(step.amount ?? 1, 1, 20) || typeof step.from !== "string") {
        return 'buy: {"buy": item, "graphic": "0x0E21", "amount": 1-20, "from": the vendor\'s title (healer)}';
      }
      return { kind: "buy", item: v, graphic, amount: (step.amount as number | undefined) ?? 1, vendor: step.from };
    }
    case "moongate": {
      const known = new Set(Object.values(MOONGATES).flat());
      return typeof v === "string" && known.has(v) ? { kind: "moongate", to: v } : `moongate: one of ${[...known].join(", ")}`;
    }
    case "cleanup":
      return v === true ? { kind: "cleanup" } : "cleanup: true";
  }
  return `unknown step ${action}`;
}

/** Reads and checks a category: the category and every problem found (empty when it is fine). */
export function parseCategory(
  raw: unknown,
  id: string,
  places: Record<string, Place>,
  creatures: ReadonlySet<string>,
): { category: Category; problems: string[] } {
  const problems: string[] = [];
  const c = (raw ?? {}) as Record<string, unknown>;
  const category: Category = { id, title: String(c.title ?? ""), about: String(c.about ?? ""), scenes: [] };
  if (c.id !== id) {
    problems.push(`${id}: id must be "${id}" (the file's name)`);
  }
  if (!category.title || !category.about) {
    problems.push(`${id}: a title and an about`);
  }
  if (!Array.isArray(c.scenes) || c.scenes.length === 0) {
    problems.push(`${id}: no scenes`);
    return { category, problems };
  }
  const seen = new Set<string>();
  for (const [i, rawScene] of c.scenes.entries()) {
    const s = (rawScene ?? {}) as Record<string, unknown>;
    const sid = typeof s.id === "string" && slug.test(s.id) ? s.id : `#${i + 1}`;
    const where = `${id}/${sid}`;
    if (sid.startsWith("#")) {
      problems.push(`${where}: id is a short lower-case name`);
    } else if (seen.has(sid)) {
      problems.push(`${where}: the id is used twice`);
    }
    seen.add(sid);
    if (typeof s.title !== "string" || !s.title) {
      problems.push(`${where}: no title`);
    }
    if (s.needs !== undefined && s.needs !== "no-session") {
      problems.push(`${where}: needs is "no-session" or left out`);
    }
    const needsNoSession = s.needs === "no-session";
    if (typeof s.start !== "string" || !places[s.start]) {
      problems.push(`${where}: start ${String(s.start)} is not a place in yerler.json`);
    } else if (nearArena(places[s.start]) && !needsNoSession) {
      problems.push(`${where}: starts at the arena: needs "no-session"`);
    }
    const ctx: Context = { scene: sid, needsNoSession, places, creatures, aliases: new Set() };
    const steps: Step[] = [];
    if (!Array.isArray(s.steps) || s.steps.length === 0) {
      problems.push(`${where}: no steps`);
    } else {
      for (const [n, rawStep] of s.steps.entries()) {
        const step = parseStep(rawStep, ctx);
        if (typeof step === "string") {
          problems.push(`${where} step ${n + 1}: ${step}`);
        } else {
          steps.push(step);
        }
      }
    }
    category.scenes.push({ id: sid, title: String(s.title ?? ""), start: String(s.start ?? ""), ...(needsNoSession ? { needs: "no-session" } : {}), steps });
  }
  return { category, problems };
}

/** Reads yerler.json: the places by name. */
export function parsePlaces(raw: unknown): { places: Record<string, Place>; problems: string[] } {
  const problems: string[] = [];
  const places: Record<string, Place> = {};
  const all = ((raw ?? {}) as { places?: Record<string, Record<string, unknown>> }).places ?? {};
  for (const [name, p] of Object.entries(all)) {
    if (!slug.test(name) || !isInt(p.x, 0, 7167) || !isInt(p.y, 0, 4095) || (p.z !== undefined && !isInt(p.z, -128, 127)) ||
      !(MAPS as readonly unknown[]).includes(p.map)) {
      problems.push(`yerler/${name}: x 0-7167, y 0-4095, z -128-127 (or none) and a facet (${MAPS.join(", ")})`);
      continue;
    }
    places[name] = { x: p.x, y: p.y, ...(p.z === undefined ? {} : { z: p.z as number }), map: p.map as MapName, ...(typeof p.about === "string" ? { about: p.about } : {}) };
  }
  if (!Object.keys(places).length) {
    problems.push("yerler: no places");
  }
  return { places, problems };
}

/** The creature types data/bestiary.json knows (lab/bestiary.py, read from ModernUO's source). */
export function bestiaryTypes(root = join(import.meta.dirname, "..", "..", "..")): Set<string> {
  return new Set(Object.keys(JSON.parse(readFileSync(join(root, "data", "bestiary.json"), "utf8")) as Record<string, unknown>));
}

/** Every category in the folder, read and checked; problems from all of them together. */
export function loadAll(dir = DATA, creatures = bestiaryTypes()): { places: Record<string, Place>; categories: Category[]; problems: string[] } {
  const placesFile = join(dir, "yerler.json");
  if (!existsSync(placesFile)) {
    return { places: {}, categories: [], problems: [`no ${placesFile}`] };
  }
  const { places, problems } = parsePlaces(JSON.parse(readFileSync(placesFile, "utf8")));
  const categories: Category[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "yerler.json").sort()) {
    const id = file.slice(0, -5);
    const parsed = parseCategory(JSON.parse(readFileSync(join(dir, file), "utf8")), id, places, creatures);
    categories.push(parsed.category);
    problems.push(...parsed.problems);
  }
  return { places, categories, problems };
}

/** A scene's `{name}` placeholders filled with the serials of the creatures it added. */
export function fillPlaceholders(command: string, serials: ReadonlyMap<string, number>): string {
  return command.replace(placeholder, (whole, alias: string) => {
    const serial = serials.get(alias);
    return serial === undefined ? whole : `0x${serial.toString(16).toUpperCase().padStart(8, "0")}`;
  });
}

/** The switch MoongateGump wants for a destination: the current facet's list comes first (index 0). */
export function moongateSwitch(map: MapName, destination: string): number | null {
  const index = MOONGATES[map]?.indexOf(destination) ?? -1;
  return index < 0 ? null : index;
}

/** The cliloc heading each facet's page in MoongateGump (PMList.SelNumber). */
const MOONGATE_PAGE: Partial<Record<MapName, number>> = { Felucca: 1012013, Trammel: 1012012, Ilshenar: 1012014, Malas: 1062039, Tokuno: 1063415 };

/**
 * The facet whose gates a moongate gump lists first (its page 1), read from the layout; null when
 * none is found. The gump puts the traveller's facet first only when the client claims that facet.
 */
export function moongateFirstFacet(layout: string): MapName | null {
  const page = /\{\s*page 1\s*\}(.*?)(?:\{\s*page 2\s*\}|$)/s.exec(layout)?.[1] ?? "";
  const found = Object.entries(MOONGATE_PAGE).find(([, cliloc]) => new RegExp(`\\b${cliloc}\\b`).test(page));
  return found ? (found[0] as MapName) : null;
}
