// Match runner: sets up rounds through the GM account, runs the duel controllers, scores them.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { modelBackend } from "../brain/backends.ts";
import { ModelBrain, RuleBrain } from "../brain/brains.ts";
import { type Tactics, loadTactics } from "../brain/tactics.ts";
import { FORMAT } from "../brain/duel-policy.ts";
import { MELEE_FORMAT } from "../brain/melee-policy.ts";
import { checkRun } from "../eval/run-checks.ts";
import { SCENARIOS } from "../eval/scenarios.ts";
import type { DuelBrain, ModuleName } from "../brain/types.ts";
import { config } from "../config.ts";
import type { MatchInfo, MonitorHub, RoundResult } from "../monitor/hub.ts";
import { type DecisionRecord, type DuelEnd, DuelController } from "./duel.ts";
import { type ArenaLayout, OBSTACLE_GRAPHICS } from "./arena.ts";
import { loadTemplate, moduleOf } from "./templates.ts";
import { Session } from "./session.ts";

/** "oracle": the skill trainer worked out from ModernUO's formulas (src/game/train-brain.ts); it plays no duels. */
export type BrainKind = "laya" | "jev" | "rules" | "random" | "oracle";
export type Fighter = {
  kind: "bot";
  name: string;
  brain: BrainKind;
  /** templates/<id>.json */
  template: string;
  /** tactics/<id>.json, or "neutral": the model's own answers */
  tactics: string;
  /** The scripted bot's reaction time for this fighter ("rules@250"); RULES_REACTION_MS otherwise. */
  reactionMs?: number;
};
export type Opponent = Fighter | { kind: "npc"; type: string } | { kind: "human"; name: string };

export type MatchOptions = {
  a: Fighter;
  b: Opponent;
  rounds: number;
  distance: number;
  /** Apply each bot's character template (templates/<id>.json) instead of keeping its own skills. */
  template: boolean;
  roundTimeoutMs: number;
  /** Obstacles to set up before the first round; "open" clears them. */
  arena: ArenaLayout;
  /** Which of the server's arenas, side by side 80 tiles apart (0, the default: the configured one). */
  slot?: number;
  /** The benchmark track this match plays for, recorded with the run (else BENCH, if set). */
  bench?: string;
  /** A GM session shared by matches running at once; without one the match opens and closes its own. */
  gm?: Session;
  /** Paced models read their pace in the state (UO Bench's paced tracks). */
  tellPace?: boolean;
};

const BRAIN_KINDS: readonly string[] = ["laya", "jev", "rules", "random", "oracle"] satisfies BrainKind[];

/**
 * A fighter's brain as a spec names it: "laya", "jev", "rules", "random", or with "@N" a time in
 * milliseconds (0-10000) to act in: the scripted bot's reaction time ("rules@250"), or a model's
 * decision time, which a quicker answer waits out ("laya@4000", the bench's equal-time tracks).
 * Null for anything else.
 */
export function parseBrain(spec: string): { brain: BrainKind; reactionMs?: number } | null {
  const [kind, at, ...rest] = spec.split("@");
  if (!BRAIN_KINDS.includes(kind) || rest.length) {
    return null;
  }
  if (at === undefined) {
    return { brain: kind as BrainKind };
  }
  const reactionMs = Number(at);
  return /^\d+$/.test(at) && reactionMs <= 10_000 ? { brain: kind as BrainKind, reactionMs } : null;
}

/** The scripted bot's reaction time, or a model's decision time when it has one, recorded with the match. */
const reaction = (f: Fighter) =>
  f.brain === "rules" ? { reactionMs: f.reactionMs ?? config.rulesReactionMs } : f.reactionMs !== undefined ? { reactionMs: f.reactionMs } : {};

/**
 * reactionMs: the scripted bot's reaction time (the configured one when left out), or a model's
 * decision time; tellPace: a model reads that decision time in its state.
 */
export function makeBrain(kind: BrainKind, module: ModuleName = "mage", reactionMs?: number, tellPace = false): DuelBrain {
  switch (kind) {
    case "rules":
      return new RuleBrain(module, reactionMs ?? config.rulesReactionMs);
    case "laya":
    case "jev":
    case "random":
      // random: a legal move at random, through the same guardrails as the models: the floor of the bench.
      return new ModelBrain(modelBackend(kind), "composite", module, reactionMs, tellPace);
    case "oracle":
      throw new Error("the oracle trains skills; it plays no duels");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const label = (f: Fighter) => (f.template === "mage" ? `${f.name} (${f.brain})` : `${f.name} (${f.brain}, ${f.template})`);
const describe = (o: Opponent) => (o.kind === "bot" ? label(o) : o.kind === "npc" ? `NPC ${o.type}` : `${o.name} (human)`);

/** "duel Neo 0x00000002 1176,3610,0 Morpheus 0x00000003 1184,3610,0 Felucca" */
function parseDuelReply(reply: string): Map<string, number> {
  const serials = new Map<string, number>();
  const parts = reply.split(" ");
  for (let i = 1; i + 1 < parts.length; i++) {
    if (parts[i + 1].startsWith("0x")) {
      serials.set(parts[i].toLowerCase(), Number.parseInt(parts[i + 1], 16));
    }
  }
  return serials;
}

export async function runMatch(o: MatchOptions, hub: MonitorHub, log: (m: string) => void): Promise<RoundResult[]> {
  // Open sessions keep the process alive: close the ones already logged in if a later login fails.
  const sessions: Session[] = [];
  const open = async (s: Promise<Session>) => {
    sessions.push(await s);
    return sessions[sessions.length - 1];
  };
  let gm: Session;
  let botA: Session;
  let botB: Session | null;
  try {
    gm = o.gm ?? (await open(Session.gm(log)));
    botA = await open(Session.bot(o.a.name, log));
    botB = o.b.kind === "bot" ? await open(Session.bot(o.b.name, log)) : null;
  } catch (err) {
    for (const s of sessions) {
      s.close();
    }
    throw err;
  }
  const brainA = makeBrain(o.a.brain, moduleOf(o.a.template), o.a.reactionMs, o.tellPace);
  const brainB = o.b.kind === "bot" ? makeBrain(o.b.brain, moduleOf(o.b.template), o.b.reactionMs, o.tellPace) : null;
  let tacticsA = await loadTactics(o.a.tactics);
  let tacticsB = o.b.kind === "bot" ? await loadTactics(o.b.tactics) : null;

  const match: MatchInfo = {
    title: `${label(o.a)} vs ${describe(o.b)}`,
    fighters: [
      { name: o.a.name, brain: o.a.brain, template: o.a.template, tactics: o.a.tactics, ...reaction(o.a) },
      o.b.kind === "bot"
        ? { name: o.b.name, brain: o.b.brain, template: o.b.template, tactics: o.b.tactics, ...reaction(o.b) }
        : o.b.kind === "npc"
          ? { name: o.b.type, brain: "npc" }
          : { name: o.b.name, brain: "human" },
    ],
    round: 0,
    rounds: o.rounds,
    arena: o.arena,
    distance: o.distance,
    ...(o.tellPace ? { tellPace: true } : {}),
    results: [],
    startedAt: Date.now(),
  };
  const records: DecisionRecord[] = [];

  // Every match states its layout, so obstacles never linger from an earlier one.
  const slot = o.slot ?? 0;
  await gm.command(`[NeoArena ${o.arena} ${slot}`).catch((err) => {
    for (const x of sessions) {
      x.close();
    }
    throw err;
  });

  // The first call to a model backend is slow (weights to the GPU, kernels compiled); pay it now.
  for (const brain of [brainA, brainB]) {
    if (brain instanceof ModelBrain) {
      await brain.decide(SCENARIOS[0].snapshot).catch((err) => log(`${brain.name} warm-up failed: ${err.message}`));
    }
  }

  try {
    for (let round = 1; round <= o.rounds; round++) {
      hub.detachAll();
      match.round = round;
      hub.setMatch(match);

      if (o.template) {
        await gm.command(`[NeoTemplate ${o.a.name} ${o.a.template}`);
        if (o.b.kind === "bot") {
          await gm.command(`[NeoTemplate ${o.b.name} ${o.b.template}`);
        }
      }

      // Every round starts in an empty arena: an NPC that outlived an earlier match would fight
      // whoever stands nearest, bots included.
      await gm.command(`[NeoClear 20 ${slot}`);

      let opponentSerial: number;
      let opponentName: string;
      if (o.b.kind === "npc") {
        await gm.command(`[NeoPlace ${o.a.name} west ${o.distance} ${slot}`);
        const reply = await gm.command(`[NeoMage ${o.b.type} ${o.distance} ${slot}`); // "mage <name> 0x... x,y,z"
        opponentSerial = Number.parseInt(reply.split(" ").find((p) => p.startsWith("0x")) ?? "0", 16);
        opponentName = o.b.type;
      } else {
        const reply = await gm.command(`[NeoDuel ${o.a.name} ${o.b.name} ${o.distance} ${slot}`);
        const serials = parseDuelReply(reply);
        opponentSerial = serials.get(o.b.name.toLowerCase()) ?? 0;
        opponentName = o.b.name;
      }
      log(`round ${round}/${o.rounds}: ${match.title}`);
      await sleep(600); // let both clients see the new positions
      match.obstacles ??= botA.world.blockingTiles(OBSTACLE_GRAPHICS);
      // An overloaded bot tires after a step or two and then cannot move at all.
      for (const bot of [botA, botB]) {
        const { weight, maxWeight } = bot?.world.stats ?? { weight: 0, maxWeight: 0 };
        if (bot && maxWeight > 0 && weight > maxWeight) {
          log(`warning: ${bot.name} carries ${weight} of ${maxWeight} stones and will be too tired to move`);
        }
      }

      const ac = new AbortController();
      const ctrlA = new DuelController(botA, brainA, opponentSerial, opponentName);
      const ctrlB = botB && brainB ? new DuelController(botB, brainB, botA.world.playerSerial, o.a.name) : null;
      // Tactics carry over between rounds: a change made in the monitor stays until the match ends.
      ctrlA.tactics = tacticsA;
      ({ spells: ctrlA.spells, offer: ctrlA.offer } = loadTemplate(o.a.template));
      if (ctrlB && tacticsB) {
        ctrlB.tactics = tacticsB;
      }
      if (ctrlB && o.b.kind === "bot") {
        ({ spells: ctrlB.spells, offer: ctrlB.offer } = loadTemplate(o.b.template));
      }
      ctrlA.on("tactics", (t: Tactics) => (tacticsA = t));
      ctrlB?.on("tactics", (t: Tactics) => (tacticsB = t));
      for (const c of [ctrlA, ctrlB]) {
        if (c) {
          hub.attach(c);
          c.on("decision", (r) => records.push(r));
        }
      }

      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<DuelEnd>((resolve) => {
        timer = setTimeout(() => resolve({ winner: null, loser: null, reason: "aborted" }), o.roundTimeoutMs);
      });
      const runs = [ctrlA.run(ac.signal), ...(ctrlB ? [ctrlB.run(ac.signal)] : [])];
      const end = await Promise.race([...runs, timeout]);
      clearTimeout(timer);
      ac.abort();
      await Promise.all(runs);

      const snapshot = ctrlA.snapshot();
      // A dead opponent may already be gone from the world, which would read as full health.
      const hpA = end.loser === o.a.name ? 0 : Math.round((100 * snapshot.us.hits) / (snapshot.us.hitsMax || 1));
      const hpB = end.loser === opponentName ? 0 : snapshot.them.healthPct;
      let result: RoundResult;
      if (end.reason === "death") {
        result = { round, winner: end.winner, loser: end.loser, reason: "death", durationMs: Date.now() - started, healthPct: { [o.a.name]: hpA, [opponentName]: hpB } };
      } else {
        const winner = hpA === hpB ? null : hpA > hpB ? o.a.name : opponentName;
        result = {
          round,
          winner,
          loser: winner === null ? null : winner === o.a.name ? opponentName : o.a.name,
          reason: "time (more health left)",
          durationMs: Date.now() - started,
          healthPct: { [o.a.name]: hpA, [opponentName]: hpB },
        };
      }
      match.results.push(result);
      hub.setMatch(match);
      log(`round ${round}: ${result.winner ?? "draw"} (${result.reason}, ${Math.round(result.durationMs / 1000)} s, health ${JSON.stringify(result.healthPct)})`);
      await sleep(3_000);
    }
  } finally {
    match.checks = checkRun(records, match.fighters);
    for (const problem of match.checks.flatMap((c) => c.problems)) {
      log(`warning: ${problem}; this run is not comparable`);
    }
    await saveRun(match, records, o.bench ?? config.bench).catch((err) => log(`could not save the run: ${err.message}`));
    // A shared GM session belongs to whoever shared it.
    for (const s of [o.gm ? null : gm, botA, botB]) {
      s?.close();
    }
  }
  return match.results;
}

/** Keeps every decision with its state: the raw material for evaluating and fine-tuning. */
/** The commit the bot runs from, marked "+dirty" when the tree has changes; "unknown" outside git. */
export function codeVersion(): string {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf8" }).trim();
  try {
    return git("rev-parse", "--short", "HEAD") + (git("status", "--porcelain") ? "+dirty" : "");
  } catch {
    return "unknown";
  }
}

async function saveRun(match: MatchInfo, records: DecisionRecord[], bench?: string): Promise<void> {
  const dir = join(import.meta.dirname, "..", "..", "..", "runs");
  await mkdir(dir, { recursive: true });
  const stamp = new Date(match.startedAt).toISOString().replace(/[:.]/g, "-");
  // Which model each bot played with, and where: runs from several machines end up side by side.
  // A "forced" move (a guardrail's, made without asking the model) names no checkpoint.
  const models = Object.fromEntries(
    records.filter((r) => r.decision.brain !== "rules" && r.decision.model !== "forced").map((r) => [r.bot, r.decision.model]),
  );
  const where = config.fleetInstance ? { instance: config.fleetInstance, ...(config.fleetLane ? { lane: config.fleetLane } : {}) } : undefined;
  // run 3: decisions carry `module` and `parts` (per-mode distributions) instead of damage/interrupt/defense.
  const versions = { run: 3, code: codeVersion(), mage: FORMAT, melee: MELEE_FORMAT, models, ...(where ? { where } : {}), ...(bench ? { bench } : {}) };
  const name = where ? `${where.instance}--${stamp}` : stamp;
  await writeFile(join(dir, `${name}.json`), JSON.stringify({ versions, match, records }, null, 1));
}
