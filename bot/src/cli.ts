// neo-vs-morpheus command line. Run through `npm run nvm -- <command>` so .env is loaded.
import { parseArgs } from "node:util";
import { ModelBrain } from "./brain/brains.ts";
import { systemOne } from "./brain/systemone.ts";
import { SUITES, scenarioRequest } from "./eval/scenarios.ts";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ConvertedLabel, convertLabel, needsRelabel, snapshotsFor } from "./distill/convert.ts";
import { daggerLabels } from "./distill/dagger.ts";
import { outcomeLabels, scoreRuns } from "./distill/outcomes.ts";
import { type LabeledState, labelStates, readJsonl } from "./distill/label.ts";
import {
  type TrainingState,
  isMovementState,
  layaStates,
  reagentShortageSnapshots,
  sampledMeleeStates,
  sampledMovementStates,
  sampledStates,
  statesFromRuns,
} from "./distill/states.ts";
import { FORMAT, compositeQuestion, describeDuel, isOutOfReach, teleportTiles } from "./brain/duel-policy.ts";
import type { DuelSnapshot, ModuleName } from "./brain/types.ts";
import { config } from "./config.ts";
import { type BrainKind, type Fighter, type Opponent, makeBrain, parseBrain, runMatch } from "./game/match.ts";
import { type Instance, formatInfo, loadFleet, pick } from "./fleet/instances.ts";
import { formatRows, readRuns, tally } from "./fleet/results.ts";
import { ARENA_LAYOUTS, type ArenaLayout } from "./game/arena.ts";
import { WEAPONS } from "./game/items.ts";
import { loadTemplate } from "./game/templates.ts";
import { Session } from "./game/session.ts";
import { SkillTrainer } from "./game/train.ts";
import { MonitorHub } from "./monitor/hub.ts";
import { PanelServer, startFleetPulls } from "./panel/server.ts";

const USAGE = `usage: npm run nvm -- <command>

  duel <Name:brain[:template[:tactics]]> <Name:brain[:template[:tactics]] | npc:Type | human:Name> [options]
       brains: laya, jev, rules; templates: templates/*.json (mage, dexer, archer; default mage)
       tactics: tactics/*.json (balanced, aggressive, cautious; default neutral, the model's own
                answers); the monitor can change them during the match. The scripted bot ignores them.
       --rounds N      rounds to play (default 3)
       --distance N    starting distance in tiles (default 8)
       --timeout S     seconds before a round is scored on health left (default 120)
       --no-template   keep the bots' own skills instead of the GM mage template
       --arena L       obstacles: open (default), pillars, wall, ring (a closed 23x23 square)
     e.g.  duel Neo:laya Morpheus:rules
           duel Neo:jev Morpheus:laya --rounds 5
           duel Neo:laya npc:EvilMageLord
           duel Neo:laya human:Trinity

  series <file.json> [--parallel N]
                      the matches listed in file.json ([{label, a, b, rounds, distance, arena,
                      timeout}], fighters as for duel), N at a time on arenas side by side (up to 8;
                      default 2); prints each match's rounds and result as it ends
  fleet setup <instance>  a fresh GPU VM: arena, bot and Laya serving, at GitHub's main plus this
                      checkout's unpushed and uncommitted changes (lab/vm/setup.sh)
  fleet status|pull [instance]
                      the machines in fleet.json (fleet.example.json): what each lane plays; their
                      new runs brought into runs/ as <instance>--<stamp>.json
  fleet results [--since T] [--instance X] [--flagged] [--by-arena]
                      round wins by matchup over runs/, from every machine
  fleet start <instance> <series.json> [--lane N] [--parallel N] [--model TAG]
  fleet stop <instance> [--lane N]
  fleet logs <instance> [--lane N] [--lines N]
                      the same tools for an assistant: the MCP server in src/fleet/mcp.ts
  panel               the control panel at localhost:MONITOR_PORT, up until Ctrl-C: live matches
                      (duels publish to it while it runs), every recorded run and its replay
  train <Name> [--partner Name] [--resist] [--minutes N] [--goal N]
                      level a bot: Magery at the best circle, Meditation and Eval Int;
                      with --partner and --resist they also curse each other for Resisting Spells
  login <Name>        log a bot in (creates account and character) and report
  bench <laya|jev>    decision latency on a typical duel state (default 20 calls)
  eval [laya] [jev] [--suite duel|movement|sight|melee]
                      decision quality on canonical moments, no clock involved

  distill states [n] [--module melee]   recorded + n sampled states to training/data/states[-melee].jsonl
  distill label [limit] [--module melee] label them with Jev (resumable) into training/data/labeled[-melee].jsonl
      --set movement  a mage batch about moving instead: recorded states out of sight or out of
                      range that labeled.jsonl lacks, plus n sampled ones (states-movement.jsonl)
  distill dagger [since]    the states Laya met in recorded runs (time stamps >= since), answered by the
                            scripted bot: DAgger rows (training/data/labeled-dagger-runs.jsonl)
  distill outcomes [since]  decisions from recorded runs (time stamps >= since) that did clearly better
                            than average, as training rows (training/data/labeled-outcome.jsonl)
  distill convert           carry every mage label over to the current question
                            (training/data/labeled-mage.jsonl; split it with training/split.py)
  distill agree [file]      how often Laya picks the teacher's move on held-out labels
                            (default training/data/test.jsonl, written by training/split.py)
`;

function fighter(spec: string): Fighter {
  const [name, brainSpec = "rules", template = "mage", tactics = "neutral"] = spec.split(":");
  const brain = parseBrain(brainSpec);
  if (!name || !brain) {
    throw new Error(`bad fighter "${spec}"; expected Name:laya|jev|rules[@ms][:template[:tactics]]`);
  }
  loadTemplate(template); // fail early on a template that does not exist
  if (tactics !== "neutral" && !existsSync(join(import.meta.dirname, "..", "..", "tactics", `${tactics}.json`))) {
    throw new Error(`no tactics/${tactics}.json`);
  }
  return { kind: "bot", name, template, tactics, ...brain };
}

function opponent(spec: string): Opponent {
  const [kind, value] = spec.split(":");
  if (kind === "npc") {
    return { kind: "npc", type: value || "EvilMageLord" };
  }
  if (kind === "human") {
    if (!value) {
      throw new Error("human:<CharacterName> needs the character's name");
    }
    return { kind: "human", name: value };
  }
  return fighter(spec);
}

async function duel(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      rounds: { type: "string", default: "3" },
      distance: { type: "string", default: "8" },
      timeout: { type: "string", default: "120" },
      "no-template": { type: "boolean", default: false },
      arena: { type: "string", default: "open" },
    },
  });
  if (positionals.length !== 2) {
    throw new Error(USAGE);
  }
  const arena = values.arena as ArenaLayout;
  if (!ARENA_LAYOUTS.includes(arena)) {
    throw new Error(`unknown arena ${values.arena}; one of ${ARENA_LAYOUTS.join(", ")}`);
  }
  const hub = new MonitorHub();
  const url = await hub.start(config.monitorPort);
  console.log(`duel monitor: ${url}`);
  try {
    const results = await runMatch(
      {
        a: fighter(positionals[0]),
        b: opponent(positionals[1]),
        rounds: Number(values.rounds),
        distance: Number(values.distance),
        template: !values["no-template"],
        roundTimeoutMs: Number(values.timeout) * 1000,
        arena,
      },
      hub,
      (m) => console.log(m),
    );
    const wins = new Map<string, number>();
    for (const r of results) {
      if (r.winner) {
        wins.set(r.winner, (wins.get(r.winner) ?? 0) + 1);
      }
    }
    console.log(`result: ${[...wins].map(([n, w]) => `${n} ${w}`).join(", ") || "all draws"} of ${results.length}`);
  } finally {
    await new Promise((r) => setTimeout(r, 2_000)); // let the page receive the last frames
    await hub.stop();
  }
}

/**
 * The characters each arena slot fights with: matches at once need bots of their own. (The
 * server refuses some names: "Smith" became "Generic Player".)
 */
const SLOT_NAMES = [
  ["Neo", "Morpheus"],
  ["Trinity", "Cypher"],
  ["Tank", "Dozer"],
  ["Switch", "Apoc"],
  ["Mouse", "Niobe"],
  ["Ghost", "Link"],
  ["Seraph", "Sati"],
  ["Rama", "Zee"],
] as const;

type SeriesEntry = { label: string; a: string; b: string; rounds?: number; distance?: number; arena?: ArenaLayout; timeout?: number };

/**
 * Several matches at once, one per arena slot, sharing one GM session. Each slot's bots take the
 * slot's own names; what is printed uses the names in the file again, so a series reads the same
 * whatever slot played it.
 */
async function series(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { parallel: { type: "string", default: "2" } } });
  if (positionals.length !== 1) {
    throw new Error(USAGE);
  }
  const entries = JSON.parse(await readFile(positionals[0], "utf8")) as SeriesEntry[];
  for (const e of entries) {
    if (e.arena && !ARENA_LAYOUTS.includes(e.arena)) {
      throw new Error(`${e.label}: unknown arena ${e.arena}`);
    }
    fighter(e.a);
    opponent(e.b); // fail before any match starts
  }
  const parallel = Math.max(1, Math.min(SLOT_NAMES.length, Number(values.parallel) || 2));
  const clock = (d: Date) => d.toTimeString().slice(0, 5);
  const gm = await Session.gm();
  const queue = [...entries];
  const play = async (slot: number) => {
    const names = SLOT_NAMES[slot];
    for (let e = queue.shift(); e; e = queue.shift()) {
      const original = [e.a.split(":")[0], e.b.split(":")[0]];
      const rename = (spec: string, i: number) =>
        spec.startsWith("npc:") || spec.startsWith("human:") ? spec : [names[i], ...spec.split(":").slice(1)].join(":");
      const back = (text: string) => text.replaceAll(names[0], original[0]).replaceAll(names[1], original[1]);
      const lines: string[] = [];
      const started = new Date();
      const hub = new MonitorHub();
      await hub.start(config.monitorPort);
      try {
        const results = await runMatch(
          {
            a: fighter(rename(e.a, 0)),
            b: opponent(rename(e.b, 1)),
            rounds: e.rounds ?? 5,
            distance: e.distance ?? 8,
            template: true,
            roundTimeoutMs: (e.timeout ?? 120) * 1000,
            arena: e.arena ?? "open",
            slot,
            gm,
          },
          hub,
          (m) => {
            if (/^round \d+:|warning|rror/.test(m)) {
              lines.push(back(m));
            }
          },
        );
        const wins = new Map<string, number>();
        for (const r of results) {
          if (r.winner) {
            wins.set(back(r.winner), (wins.get(back(r.winner)) ?? 0) + 1);
          }
        }
        lines.push(`result: ${[...wins].map(([n, w]) => `${n} ${w}`).join(", ") || "all draws"} of ${results.length}`);
      } catch (err) {
        lines.push(`error: ${(err as Error).message}`);
      } finally {
        await hub.stop();
      }
      console.log([`== ${e.label} (slot ${slot}, ${clock(started)}-${clock(new Date())})`, ...lines].join("\n"));
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(parallel, entries.length) }, (_, slot) => play(slot)));
  } finally {
    gm.close();
  }
}

async function fleet(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      instance: { type: "string" },
      flagged: { type: "boolean" },
      "by-arena": { type: "boolean" },
      lane: { type: "string" },
      parallel: { type: "string" },
      model: { type: "string" },
      lines: { type: "string" },
    },
  });
  const [action, name, seriesFile] = positionals;
  const num = (v?: string) => (v === undefined ? undefined : Number(v));
  if (action === "results") {
    const since = values.since ? Date.parse(values.since) : undefined;
    console.log(formatRows(tally(await readRuns(), { since, instance: values.instance, includeFlagged: values.flagged, byArena: values["by-arena"] })));
    return;
  }
  if (!["setup", "status", "pull", "start", "stop", "logs"].includes(action) || (["setup", "start", "stop", "logs"].includes(action) && !name)) {
    throw new Error(USAGE);
  }
  const step = (i: Instance): Promise<string> => {
    switch (action) {
      case "setup":
        return i.setup();
      case "status":
        return i.info().then(formatInfo);
      case "pull":
        return i.pull();
      case "start":
        if (!seriesFile) {
          throw new Error("fleet start <instance> <series.json>");
        }
        return i.start({ series: seriesFile, lane: num(values.lane), parallel: num(values.parallel), model: values.model });
      case "stop":
        return i.stop(num(values.lane));
      default:
        return i.logs(num(values.lane), num(values.lines));
    }
  };
  const answers = await Promise.all(
    pick(await loadFleet(), name).map(async (i) => `== ${i.name}\n${await step(i).catch((err: Error) => `error: ${err.message}`)}`),
  );
  console.log(answers.join("\n\n"));
}

async function panel(): Promise<void> {
  const server = new PanelServer();
  const url = await server.start(config.monitorPort);
  server.warm();
  const pulls = startFleetPulls();
  console.log(`control panel: ${url} (Ctrl-C stops it); the fleet's runs are pulled every 10 minutes`);
  await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
  clearInterval(pulls);
  await server.stop();
}

async function train(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      partner: { type: "string" },
      resist: { type: "boolean", default: false },
      minutes: { type: "string", default: "30" },
      goal: { type: "string", default: "100" },
    },
  });
  const name = positionals[0] ?? "Neo";
  const gm = await Session.gm();
  const sessions = [await Session.bot(name)];
  if (values.partner) {
    sessions.push(await Session.bot(values.partner));
  }
  // Put the trainees next to each other at the arena, stocked with reagents.
  await gm.command(`[NeoPlace ${name} west 2`);
  if (values.partner) {
    await gm.command(`[NeoPlace ${values.partner} east 2`);
  }
  await new Promise((r) => setTimeout(r, 1_000));

  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), Number(values.minutes) * 60_000);
  const trainers = sessions.map((s) => new SkillTrainer(s));
  if (trainers.length === 2) {
    trainers[0].partner = sessions[1].world.playerSerial;
    trainers[1].partner = sessions[0].world.playerSerial;
    trainers[0].resist = trainers[1].resist = values.resist;
  }
  const start = trainers.map((t) => t.snapshot());
  const report = () => {
    for (const [i, t] of trainers.entries()) {
      const now = t.snapshot();
      const line = Object.entries(now)
        .map(([k, v]) => `${k} ${v.toFixed(1)}${v > start[i][k] ? ` (+${(v - start[i][k]).toFixed(1)})` : ""}`)
        .join(", ");
      console.log(`${t.session.name}: ${line} | ${t.casts} casts, ${t.fizzles} fizzled`);
    }
  };
  const ticker = setInterval(report, 60_000);
  for (const t of trainers) {
    t.on("log", (m) => console.log(`${t.session.name}: ${m}`));
  }
  try {
    await Promise.all(
      trainers.map((t) => t.run(ac.signal, Number(values.goal), async () => void (await gm.command(`[NeoPrep ${t.session.name}`)))),
    );
  } finally {
    clearTimeout(deadline);
    clearInterval(ticker);
    report();
    for (const s of [gm, ...sessions]) {
      s.close();
    }
  }
}

async function login(name: string): Promise<void> {
  const started = performance.now();
  const s = await Session.bot(name, (m) => console.log(m));
  await new Promise((r) => setTimeout(r, 1_000));
  const p = s.world.player;
  console.log(
    `${name} in world after ${Math.round(performance.now() - started)} ms: serial 0x${p.serial.toString(16)} ` +
      `at ${p.x},${p.y},${p.z}, health ${p.hits}/${p.hitsMax}, mana ${p.mana}/${p.manaMax}` +
      `${s.login?.created ? " (new character)" : ""}`,
  );
  s.close();
}

/** A mid-duel state, to time the backend without a game running. */
function sampleSnapshot(): DuelSnapshot {
  const s: DuelSnapshot = {
    now: Date.now(),
    us: {
      name: "Neo", serial: 2, hits: 66, hitsMax: 100, mana: 71, manaMax: 101, stam: 40, stamMax: 40,
      poisoned: false, x: 1176, y: 3610, z: 0, readyInMs: 0, lastSpell: "Harm", lastSpellAgoMs: 1600,
    },
    them: {
      name: "Morpheus", serial: 3, healthPct: 20, poisoned: false, x: 1181, y: 3610, z: 0, dead: false,
      casting: "explosion", castingForMs: 400, landsInMs: 1600, distance: 5, inLineOfSight: true, inRange: true,
    },
    reagents: { blackPearl: 50, bloodmoss: 50, garlic: 50, ginseng: 50, mandrakeRoot: 50, nightshade: 50, sulfurousAsh: 50, spidersSilk: 50 },
    tiles: [],
    recent: ["Neo cast Harm", "Morpheus took 8 damage", "Morpheus began casting Explosion"],
  };
  s.tiles = teleportTiles(s);
  return s;
}

async function bench(kind: string, n: number): Promise<void> {
  const brain = makeBrain(kind as BrainKind);
  if (!(brain instanceof ModelBrain)) {
    throw new Error("bench needs laya or jev");
  }
  const snapshot = sampleSnapshot();
  console.log(`state (${describeDuel(snapshot).length} chars):\n${describeDuel(snapshot)}\n`);
  const latencies: number[] = [];
  let last: Awaited<ReturnType<ModelBrain["decide"]>> | undefined;
  for (let i = 0; i < n; i++) {
    last = await brain.decide(snapshot);
    latencies.push(last.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  const q = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))].toFixed(1);
  console.log(`${last?.model} (${brain.style}): ${n} calls, p50 ${q(0.5)} ms, p95 ${q(0.95)} ms; ${last?.inputTokens} input tokens`);
  if (last) {
    for (const [label, d] of [["mode", last.mode] as const, ...Object.entries(last.parts)]) {
      const top = Object.entries(d.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3);
      console.log(`  ${label.padEnd(10)} ${top.map(([k, p]) => `${k} ${(p * 100).toFixed(0)}%`).join("  ")}`);
    }
    console.log(`  plan       ${JSON.stringify(last.plan)} — ${last.why}${last.overrides.length ? ` [${last.overrides.join("; ")}]` : ""}`);
  }
}


/** Top-1 accuracy and probability mass on acceptable answers, per backend, same questions. */
async function evaluate(args: string[]): Promise<void> {
  const suiteAt = args.indexOf("--suite");
  const suiteName = suiteAt >= 0 ? args[suiteAt + 1] : "duel";
  const scenarios = SUITES[suiteName];
  if (!scenarios) {
    throw new Error(`unknown suite ${suiteName}; one of ${Object.keys(SUITES).join(", ")}`);
  }
  const kinds = args.filter((a, i) => a !== "--suite" && i !== suiteAt + 1);
  if (!kinds.length) {
    kinds.push("laya");
  }
  const rows: Record<string, string>[] = [];
  const summary: Record<string, { right: number; mass: number; ms: number }> = {};
  for (const kind of kinds) {
    const brain = makeBrain(kind as BrainKind);
    if (!(brain instanceof ModelBrain)) {
      throw new Error("eval needs laya and/or jev");
    }
    summary[kind] = { right: 0, mass: 0, ms: 0 };
    for (const [i, sc] of scenarios.entries()) {
      const req = scenarioRequest(sc);
      const d = await systemOne(brain.backend, req.state, req.questions);
      const a = d.answers.move;
      const ok = sc.accept.includes(a.choice);
      const mass = sc.accept.reduce((sum, k) => sum + (a.probabilities[k] ?? 0), 0);
      summary[kind].right += ok ? 1 : 0;
      summary[kind].mass += mass;
      summary[kind].ms += d.latencyMs;
      rows[i] ??= { scenario: sc.id, expected: sc.accept.slice(0, 2).join(" | ") + (sc.accept.length > 2 ? " …" : "") };
      rows[i][kind] = `${ok ? "✓" : "✗"} ${a.choice} ${(a.probabilities[a.choice] * 100).toFixed(0)}%`;
    }
  }
  for (const r of rows) {
    console.log(`${r.scenario}\n    expected ${r.expected}\n${kinds.map((k) => `    ${k.padEnd(5)} ${r[k]}`).join("\n")}`);
  }
  console.log("");
  for (const [k, s] of Object.entries(summary)) {
    const n = scenarios.length;
    console.log(`${k.padEnd(5)} top-1 ${s.right}/${n} (${Math.round((100 * s.right) / n)}%) · mass on good answers ${Math.round((100 * s.mass) / n)}% · avg ${Math.round(s.ms / n)} ms`);
  }
}

const DATA = join(import.meta.dirname, "..", "..", "training", "data");

async function distill(sub: string | undefined, rest: string[]): Promise<void> {
  await mkdir(DATA, { recursive: true });
  // --module melee keeps the fighters' states and labels apart from the mage's.
  const moduleAt = rest.indexOf("--module");
  const module = (moduleAt >= 0 ? rest[moduleAt + 1] : "mage") as ModuleName;
  if (moduleAt >= 0) {
    rest.splice(moduleAt, 2);
  }
  if (module !== "mage" && module !== "melee") {
    throw new Error(`unknown module ${module}; mage or melee`);
  }
  // --set movement: a separate batch of mage states about moving, in its own files.
  // --set mixed: recorded states against a different kind of fighter (a mage against a dexer or
  // an archer; an archer, or a fighter against a caster or an archer), mage or melee.
  const setAt = rest.indexOf("--set");
  const set = setAt >= 0 ? rest[setAt + 1] : null;
  if (setAt >= 0) {
    rest.splice(setAt, 2);
  }
  const sets: Record<string, string[]> = { mage: ["movement", "relabel", "refresh", "mixed", "laya"], melee: ["mixed", "laya"] };
  if (set !== null && !sets[module].includes(set)) {
    throw new Error(`unknown set ${set} for the ${module}; it has ${sets[module].join(", ")}`);
  }
  const suffix = set ? `-${module === "melee" ? "melee-" : ""}${set}` : module === "mage" ? "" : `-${module}`;
  const statesPath = join(DATA, `states${suffix}.jsonl`);
  // Fresh answers for labels that could not be carried over go where `distill convert` prefers them.
  const labeledPath = join(DATA, set === "relabel" || set === "refresh" ? "relabeled-mage.jsonl" : `labeled${suffix}.jsonl`);
  if (sub === "states") {
    const runs = join(import.meta.dirname, "..", "..", "runs");
    const n = Number(rest[0] ?? 1200);
    let fromRuns;
    let sampled;
    if (set === "refresh") {
      // Asked again with today's question: labelled states in reach (their moves changed the most),
      // three in four, and states short of reagents, one in four.
      const labeled = [
        ...(await readJsonl<LabeledState>(join(DATA, "labeled.jsonl"))),
        ...(await readJsonl<LabeledState>(join(DATA, "labeled-movement.jsonl"))),
      ];
      const snaps = await snapshotsFor(labeled.map((l) => l.id), runs);
      const order = labeled.map((l) => l.id).filter((id) => snaps.has(id) && !isOutOfReach(snaps.get(id) as DuelSnapshot));
      // A seeded shuffle, so the same batch comes out every time.
      let seed = 20261002;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const fromLabels = order.slice(0, Math.round(n * 0.75)).map((id) => {
        const s = snaps.get(id) as DuelSnapshot;
        return { id, source: id.startsWith("run:") ? "run" : "sampled", module: "mage", format: FORMAT, state: describeDuel(s), questions: compositeQuestion(s) } as TrainingState;
      });
      fromRuns = fromLabels;
      sampled = reagentShortageSnapshots(Math.round(n * 0.25)).map((s, i) => ({
        id: `reagents:20261002:${i}`, source: "sampled", module: "mage", format: FORMAT, state: describeDuel(s), questions: compositeQuestion(s),
      }) as TrainingState);
    } else if (set === "mixed") {
      // Up to n, a seeded sample: states differ round by round, and every label costs a credit.
      const ranged = (name?: string | null) => !!name && !!Object.values(WEAPONS).find((w) => w.name === name)?.ranged;
      const mixed = (s: DuelSnapshot) =>
        module === "mage" ? !!s.them.weapon : !!s.us.weapon?.ranged || !s.them.weapon || ranged(s.them.weapon);
      const all = await statesFromRuns(runs, module, mixed);
      let seed = 20261003;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      fromRuns = all.slice(0, n);
      sampled = [] as TrainingState[];
    } else if (set === "laya") {
      // The states Laya met in clean runs since --since (a run file time stamp), for Jev to label.
      const sinceAt = rest.indexOf("--since");
      const since = sinceAt >= 0 ? rest[sinceAt + 1] : "";
      const modelAt = rest.indexOf("--model");
      fromRuns = await layaStates(runs, module, since, n, modelAt >= 0 ? rest[modelAt + 1] : undefined);
      sampled = [] as TrainingState[];
    } else if (set === "movement") {
      // States the main mage batch already paid for are not asked again.
      const paid = new Set((await readJsonl<LabeledState>(join(DATA, "labeled.jsonl"))).map((s) => s.state));
      fromRuns = (await statesFromRuns(runs, module, isMovementState)).filter((s) => !paid.has(s.state));
      sampled = sampledMovementStates(n);
    } else {
      fromRuns = await statesFromRuns(runs, module);
      sampled = module === "melee" ? sampledMeleeStates(n) : sampledStates(n);
    }
    const all = [...fromRuns, ...sampled];
    await writeFile(statesPath, all.map((s) => JSON.stringify(s)).join("\n") + "\n");
    console.log(`${all.length} ${set ?? module} states (${fromRuns.length} from runs, ${sampled.length} sampled) -> ${statesPath}`);
  } else if (sub === "convert") {
    // Every mage label, whatever question it was asked with, carried over to the current one. A
    // state the teacher answered again with the current question (relabeled-mage.jsonl) keeps
    // that fresh answer instead of a converted one.
    const all = [
      ...(await readJsonl<LabeledState>(join(DATA, "labeled.jsonl"))),
      ...(await readJsonl<LabeledState>(join(DATA, "labeled-movement.jsonl"))),
      ...(await readJsonl<LabeledState>(join(DATA, "relabeled-mage.jsonl"))),
    ];
    const current = new Map(all.filter((r) => r.format?.question === FORMAT.question).map((r) => [r.id, r]));
    const rows = [
      ...new Map(all.map((r) => [r.id, current.get(r.id) ?? r])).values(),
    ];
    const snapshots = await snapshotsFor(
      rows.map((r) => r.id),
      join(import.meta.dirname, "..", "..", "runs"),
    );
    const out: ConvertedLabel[] = [];
    const relabel: TrainingState[] = [];
    const dropped = new Map<string, number>();
    for (const row of rows) {
      const s = snapshots.get(row.id);
      if (s && needsRelabel(row, s)) {
        relabel.push({ id: row.id, source: row.source, module: "mage", format: FORMAT, state: row.state, questions: compositeQuestion(s) });
        continue;
      }
      const converted = s ? convertLabel(row, s) : "no snapshot for this id";
      if (typeof converted === "string") {
        dropped.set(converted, (dropped.get(converted) ?? 0) + 1);
      } else {
        out.push(converted);
      }
    }
    const path = join(DATA, "labeled-mage.jsonl");
    await writeFile(path, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
    // Asked again with `distill label --set relabel`; the fresh answers land in relabeled-mage.jsonl.
    await writeFile(join(DATA, "states-relabel.jsonl"), relabel.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const kept = out.map((r) => r.teacher.converted?.kept ?? 1);
    const mean = kept.reduce((a, b) => a + b, 0) / Math.max(kept.length, 1);
    console.log(`${out.length} of ${rows.length} mage labels in ${FORMAT.question} -> ${path}`);
    console.log(`  ${relabel.length} to ask again (distill label --set relabel)`);
    console.log(`  the teacher's probability on options still offered: mean ${(mean * 100).toFixed(0)}%, ` +
      `under 20% in ${kept.filter((k) => k < 0.2).length}`);
    for (const [why, n] of dropped) {
      console.log(`  dropped ${n}: ${why}`);
    }
  } else if (sub === "outcomes") {
    // What happened after every recorded decision, as training rows (see distill/outcomes.ts).
    const since = rest[0] ?? "";
    const scored = await scoreRuns(join(import.meta.dirname, "..", "..", "runs"), since, (m) => console.log(m));
    const rows = outcomeLabels(scored);
    const path = join(DATA, "labeled-outcome.jsonl");
    await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const byModule = Object.entries(Object.groupBy(rows, (r) => r.module ?? "mage")).map(([m, rs]) => `${m} ${rs?.length}`);
    console.log(`${scored.length} decisions scored, ${rows.length} clearly better than average (${byModule.join(", ")}) -> ${path}`);
  } else if (sub === "dagger") {
    // Laya's own states, answered by the scripted bot (see distill/dagger.ts).
    const since = rest[0] ?? "";
    const { rows, states, agreed, skippedRuns } = await daggerLabels(join(import.meta.dirname, "..", "..", "runs"), since, (m) => console.log(m));
    const path = join(DATA, "labeled-dagger-runs.jsonl");
    await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const byModule = Object.entries(Object.groupBy(rows, (r) => r.module ?? "mage")).map(([m, rs]) => `${m} ${rs?.length}`);
    console.log(`${states} Laya decisions, ${rows.length} distinct states labelled (${byModule.join(", ")}); ` +
      `the expert agreed with Laya on ${Math.round((100 * agreed) / Math.max(1, rows.length))}%; ${skippedRuns} runs failed the checks -> ${path}`);
  } else if (sub === "label") {
    const brain = makeBrain("jev");
    if (!(brain instanceof ModelBrain)) {
      throw new Error("the teacher must be a model backend");
    }
    // Generous timeout: a response lost to a timeout cannot be fetched again (FreeJev answers 409),
    // and a busy FreeJev can take a minute or more.
    const teacher = { ...brain.backend, timeoutMs: 120_000 };
    const n = await labelStates(teacher, statesPath, labeledPath, Number(rest[0] ?? 1e9), (m) => console.log(m));
    console.log(`labeled ${n} states`);
  } else if (sub === "agree") {
    const brain = makeBrain("laya");
    if (!(brain instanceof ModelBrain)) {
      throw new Error("the student must be a model backend");
    }
    const text = await readFile(rest[0] ?? join(DATA, "test.jsonl"), "utf8");
    const items = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as LabeledState);
    const top = (p: Record<string, number>) => Object.entries(p).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    // The teacher's most common move is an easy score; agreement on the other states says more.
    const counts = new Map<string, number>();
    for (const it of items) {
      const t = top(it.teacher.probabilities);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let same = 0;
    let sameRest = 0;
    let mass = 0;
    let ms = 0;
    for (const it of items) {
      const d = await systemOne(brain.backend, it.state, it.questions);
      const pick = top(d.answers.move.probabilities);
      const teacher = top(it.teacher.probabilities);
      same += pick === teacher ? 1 : 0;
      sameRest += pick === teacher && teacher !== common ? 1 : 0;
      mass += it.teacher.probabilities[pick] ?? 0;
      ms += d.latencyMs;
    }
    const others = items.length - (counts.get(common) ?? 0);
    const pct = (x: number, n = items.length) => `${((100 * x) / n).toFixed(1)}%`;
    console.log(`${items.length} held-out states: the teacher's move ${same} times (${pct(same)}), ` +
      `teacher probability of the pick ${pct(mass)}, ${Math.round(ms / items.length)} ms per decision`);
    console.log(`  where the teacher did not pick its usual ${common}: ${sameRest}/${others} (${pct(sameRest, others)}); ` +
      `always answering ${common} scores ${pct(items.length - others)}`);
  } else {
    console.log(USAGE);
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case "duel":
      await duel(args);
      break;
    case "panel":
      await panel();
      break;
    case "series":
      await series(args);
      break;
    case "fleet":
      await fleet(args);
      break;
    case "train":
      await train(args);
      break;
    case "login":
      await login(args[0] ?? "Neo");
      break;
    case "bench":
      await bench(args[0] ?? "laya", Number(args[1] ?? 20));
      break;
    case "distill":
      await distill(args[0], args.slice(1));
      break;
    case "eval":
      await evaluate(args);
      break;
    default:
      console.log(USAGE);
      process.exitCode = command ? 2 : 0;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
