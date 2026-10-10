// Sanity checks on a recorded match, so that a contaminated run is noticed before it is compared
// or learnt from. Both failures below have happened: a Protection that outlived its round (under
// AOS rules it stays on through death until cast again) made every later cast 0.5 s slower and
// immune to disruption, and another program on the Mac's GPU slowed Laya from 0.3 s to 1-2 s.
import { castDelayMs } from "../game/caster.ts";
import type { DecisionRecord } from "../game/duel.ts";
import { spell } from "../uo/spells.ts";

/** How much longer than its cast delay a bot's typical cast may take (network, server ticks). */
export const CAST_DRIFT_LIMIT_MS = 200;
/** A cast this much late counts as slow; clean runs have none (at most 0.2 s late). */
const SLOW_CAST_MS = 300;
/** Share of slow casts that marks a run, so that an effect carried into a few rounds shows too. */
const SLOW_SHARE_LIMIT = 0.05;
/** Laya's typical decision time above this means a shared GPU (normally 0.25-0.4 s on Metal). */
export const LATENCY_LIMIT_MS = 600;

export type RunCheck = {
  bot: string;
  brain: string;
  /** Casts whose target cursor arrived, the ones a cast time is measured on. */
  casts: number;
  /** Median of measured cast time minus the spell's cast delay; null under 5 casts. */
  castDriftMs: number | null;
  /** Casts at least 0.3 s late. */
  slowCasts: number;
  /** Median decision time. */
  latencyMs: number;
  problems: string[];
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

type Checked = Pick<DecisionRecord, "bot" | "decision" | "outcome"> & { snapshot: { us: { protection?: boolean } } };

/** Brains that ask a model server, and so can fail to answer at all. */
const MODEL_BRAINS = new Set(["laya", "laya-b", "jev"]);

/**
 * The checks of each bot that decided, and, given the match's fighters, of each model fighter that
 * never did: when its server is down or every request times out it stands still and loses, which
 * leaves no decisions to check (this happened on a cloud node whose model ran without its GPU).
 */
export function checkRun(records: Checked[], fighters: { name: string; brain: string; reactionMs?: number }[] = []): RunCheck[] {
  const silent = fighters
    .filter((f) => MODEL_BRAINS.has(f.brain) && !records.some((r) => r.bot === f.name))
    .map((f) => ({
      bot: f.name, brain: f.brain, casts: 0, castDriftMs: null, slowCasts: 0, latencyMs: 0,
      problems: [`${f.name} (${f.brain}) made no decisions (its model server down, or every request timed out?)`],
    }));
  // A model with a decision time of its own (the bench's equal-time tracks) is late past that time.
  const budgets = new Map(fighters.filter((f) => f.brain !== "rules" && f.reactionMs !== undefined).map((f) => [f.name, f.reactionMs as number]));
  return [...decided(records, budgets), ...silent];
}

function decided(records: Checked[], budgets: Map<string, number> = new Map()): RunCheck[] {
  return [...new Set(records.map((r) => r.bot))].map((bot) => {
    const mine = records.filter((r) => r.bot === bot);
    const drifts = mine.flatMap((r) => {
      // A Protection the bot cast this round slows its casts by 0.5 s: part of the game, not a fault.
      if (r.snapshot.us.protection) {
        return [];
      }
      const p = r.decision.plan;
      const key = p.kind === "cast" ? p.spell : p.kind === "teleport" ? "teleport" : null;
      return key && r.outcome?.castMs ? [r.outcome.castMs - castDelayMs(spell(key))] : [];
    });
    const castDriftMs = drifts.length >= 5 ? Math.round(median(drifts)) : null;
    const slowCasts = drifts.filter((d) => d >= SLOW_CAST_MS).length;
    const brain = mine[0]?.decision.brain ?? "unknown";
    const latencyMs = Math.round(median(mine.map((r) => r.decision.latencyMs)));
    const problems: string[] = [];
    if (castDriftMs !== null && castDriftMs > CAST_DRIFT_LIMIT_MS) {
      problems.push(`${bot}'s casts took ${castDriftMs} ms longer than their cast delay (an effect left from an earlier round?)`);
    } else if (slowCasts >= 3 && slowCasts > SLOW_SHARE_LIMIT * drifts.length) {
      problems.push(`${slowCasts} of ${bot}'s ${drifts.length} casts were 0.3 s or more late (an effect left from an earlier round?)`);
    }
    const budget = budgets.get(bot);
    if ((brain === "laya" || (budget !== undefined && MODEL_BRAINS.has(brain))) && latencyMs > (budget ?? 0) + LATENCY_LIMIT_MS) {
      problems.push(`${bot} took ${latencyMs} ms per decision (is another program using the GPU?)`);
    }
    return { bot, brain, casts: drifts.length, castDriftMs, slowCasts, latencyMs, problems };
  });
}
