// Match runner: sets up rounds through the GM account, runs the duel controllers, scores them.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelBrain, RuleBrain } from "../brain/brains.ts";
import { type Tactics, loadTactics } from "../brain/tactics.ts";
import { FORMAT } from "../brain/duel-policy.ts";
import { MELEE_FORMAT } from "../brain/melee-policy.ts";
import { SCENARIOS } from "../eval/scenarios.ts";
import type { DuelBrain, ModuleName } from "../brain/types.ts";
import { config, requireSetting } from "../config.ts";
import type { MatchInfo, MonitorHub, RoundResult } from "../monitor/hub.ts";
import { type DecisionRecord, type DuelEnd, DuelController } from "./duel.ts";
import type { ArenaLayout } from "./arena.ts";
import { moduleOf } from "./templates.ts";
import { Session } from "./session.ts";

export type BrainKind = "laya" | "jev" | "rules";
export type Fighter = {
  kind: "bot";
  name: string;
  brain: BrainKind;
  /** templates/<id>.json */
  template: string;
  /** tactics/<id>.json, or "neutral": the model's own answers */
  tactics: string;
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
};

export function makeBrain(kind: BrainKind, module: ModuleName = "mage"): DuelBrain {
  switch (kind) {
    case "rules":
      return new RuleBrain(module);
    case "laya":
      return new ModelBrain({
        name: "laya",
        url: config.layaUrl,
        apiKey: config.layaApiKey || undefined,
        model: "typed-decisions",
        timeoutMs: 20_000, // CPU-only in Docker on macOS: seconds, not milliseconds
      }, "composite", module);
    case "jev":
      return new ModelBrain({
        name: "jev",
        url: config.jevUrl,
        path: config.jevPath,
        apiKey: requireSetting(config.jevApiKey, "JEV_API_KEY"),
        model: config.jevModel || undefined,
        timeoutMs: 15_000,
      }, "composite", module);
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
    gm = await open(Session.gm(log));
    botA = await open(Session.bot(o.a.name, log));
    botB = o.b.kind === "bot" ? await open(Session.bot(o.b.name, log)) : null;
  } catch (err) {
    for (const s of sessions) {
      s.close();
    }
    throw err;
  }
  const brainA = makeBrain(o.a.brain, moduleOf(o.a.template));
  const brainB = o.b.kind === "bot" ? makeBrain(o.b.brain, moduleOf(o.b.template)) : null;
  let tacticsA = await loadTactics(o.a.tactics);
  let tacticsB = o.b.kind === "bot" ? await loadTactics(o.b.tactics) : null;

  const match: MatchInfo = {
    title: `${label(o.a)} vs ${describe(o.b)}`,
    fighters: [
      { name: o.a.name, brain: o.a.brain, template: o.a.template, tactics: o.a.tactics },
      o.b.kind === "bot"
        ? { name: o.b.name, brain: o.b.brain, template: o.b.template, tactics: o.b.tactics }
        : o.b.kind === "npc"
          ? { name: o.b.type, brain: "npc" }
          : { name: o.b.name, brain: "human" },
    ],
    round: 0,
    rounds: o.rounds,
    results: [],
    startedAt: Date.now(),
  };
  const records: DecisionRecord[] = [];

  // Every match states its layout, so obstacles never linger from an earlier one.
  await gm.command(`[NeoArena ${o.arena}`).catch((err) => {
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
      await gm.command("[NeoClear");

      let opponentSerial: number;
      let opponentName: string;
      if (o.b.kind === "npc") {
        await gm.command(`[NeoPlace ${o.a.name} west ${o.distance}`);
        const reply = await gm.command(`[NeoMage ${o.b.type} ${o.distance}`); // "mage <name> 0x... x,y,z"
        opponentSerial = Number.parseInt(reply.split(" ").find((p) => p.startsWith("0x")) ?? "0", 16);
        opponentName = o.b.type;
      } else {
        const reply = await gm.command(`[NeoDuel ${o.a.name} ${o.b.name} ${o.distance}`);
        const serials = parseDuelReply(reply);
        opponentSerial = serials.get(o.b.name.toLowerCase()) ?? 0;
        opponentName = o.b.name;
      }
      log(`round ${round}/${o.rounds}: ${match.title}`);
      await sleep(600); // let both clients see the new positions
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
      if (ctrlB && tacticsB) {
        ctrlB.tactics = tacticsB;
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
    await saveRun(match, records).catch((err) => log(`could not save the run: ${err.message}`));
    for (const s of [gm, botA, botB]) {
      s?.close();
    }
  }
  return match.results;
}

/** Keeps every decision with its state: the raw material for evaluating and fine-tuning. */
/** The commit the bot runs from, marked "+dirty" when the tree has changes; "unknown" outside git. */
function codeVersion(): string {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf8" }).trim();
  try {
    return git("rev-parse", "--short", "HEAD") + (git("status", "--porcelain") ? "+dirty" : "");
  } catch {
    return "unknown";
  }
}

async function saveRun(match: MatchInfo, records: DecisionRecord[]): Promise<void> {
  const dir = join(import.meta.dirname, "..", "..", "..", "runs");
  await mkdir(dir, { recursive: true });
  const stamp = new Date(match.startedAt).toISOString().replace(/[:.]/g, "-");
  // run 3: decisions carry `module` and `parts` (per-mode distributions) instead of damage/interrupt/defense.
  const versions = { run: 3, code: codeVersion(), mage: FORMAT, melee: MELEE_FORMAT };
  await writeFile(join(dir, `${stamp}.json`), JSON.stringify({ versions, match, records }, null, 1));
}
