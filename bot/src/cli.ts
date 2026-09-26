// neo-vs-morpheus command line. Run through `npm run nvm -- <command>` so .env is loaded.
import { parseArgs } from "node:util";
import { ModelBrain } from "./brain/brains.ts";
import { systemOne } from "./brain/systemone.ts";
import { SCENARIOS, scenarioRequest } from "./eval/scenarios.ts";
import { describeDuel, teleportTiles } from "./brain/duel-policy.ts";
import type { DuelSnapshot } from "./brain/types.ts";
import { config } from "./config.ts";
import { type BrainKind, type Fighter, type Opponent, makeBrain, runMatch } from "./game/match.ts";
import { Session } from "./game/session.ts";
import { MonitorHub } from "./monitor/hub.ts";

const USAGE = `usage: npm run nvm -- <command>

  duel <Name:brain> <Name:brain | npc:Type | human:Name> [options]
       brains: laya, jev, rules
       --rounds N      rounds to play (default 3)
       --distance N    starting distance in tiles (default 8)
       --timeout S     seconds before a round is scored on health left (default 120)
       --no-template   keep the bots' own skills instead of the GM mage template
     e.g.  duel Neo:laya Morpheus:rules
           duel Neo:jev Morpheus:laya --rounds 5
           duel Neo:laya npc:EvilMageLord
           duel Neo:laya human:Trinity

  login <Name>        log a bot in (creates account and character) and report
  bench <laya|jev>    decision latency on a typical duel state (default 20 calls)
  eval [laya] [jev]   decision quality on canonical duel moments, no clock involved
`;

const BRAINS = new Set(["laya", "jev", "rules"]);

function fighter(spec: string): Fighter {
  const [name, brain = "rules"] = spec.split(":");
  if (!name || !BRAINS.has(brain)) {
    throw new Error(`bad fighter "${spec}"; expected Name:laya|jev|rules`);
  }
  return { kind: "bot", name, brain: brain as BrainKind };
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
    },
  });
  if (positionals.length !== 2) {
    throw new Error(USAGE);
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
    for (const [label, d] of [["mode", last.mode], ["damage", last.damage], ["interrupt", last.interrupt], ["defense", last.defense]] as const) {
      const top = Object.entries(d.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3);
      console.log(`  ${label.padEnd(10)} ${top.map(([k, p]) => `${k} ${(p * 100).toFixed(0)}%`).join("  ")}`);
    }
    console.log(`  plan       ${JSON.stringify(last.plan)} — ${last.why}${last.overrides.length ? ` [${last.overrides.join("; ")}]` : ""}`);
  }
}


/** Top-1 accuracy and probability mass on acceptable answers, per backend, same questions. */
async function evaluate(kinds: string[]): Promise<void> {
  const rows: Record<string, string>[] = [];
  const summary: Record<string, { right: number; mass: number; ms: number }> = {};
  for (const kind of kinds) {
    const brain = makeBrain(kind as BrainKind);
    if (!(brain instanceof ModelBrain)) {
      throw new Error("eval needs laya and/or jev");
    }
    summary[kind] = { right: 0, mass: 0, ms: 0 };
    for (const [i, sc] of SCENARIOS.entries()) {
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
    const n = SCENARIOS.length;
    console.log(`${k.padEnd(5)} top-1 ${s.right}/${n} (${Math.round((100 * s.right) / n)}%) · mass on good answers ${Math.round((100 * s.mass) / n)}% · avg ${Math.round(s.ms / n)} ms`);
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case "duel":
      await duel(args);
      break;
    case "login":
      await login(args[0] ?? "Neo");
      break;
    case "bench":
      await bench(args[0] ?? "laya", Number(args[1] ?? 20));
      break;
    case "eval":
      await evaluate(args.length ? args : ["laya"]);
      break;
    default:
      console.log(USAGE);
      process.exitCode = command ? 2 : 0;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
