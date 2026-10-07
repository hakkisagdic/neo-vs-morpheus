// The bench's numbers: a share of points for a player, with an honest 95% interval. The rounds of
// one run share its arena, opponent and seating, so they are not independent draws: intervals and
// comparisons come from a bootstrap over runs (the clusters), never over rounds. Wilson's interval,
// which treats rounds as independent, is kept beside it to show how much narrower that would claim.

/** One run as the bench counts it: the player's points (a win 1, a draw 1/2) out of its rounds. */
export type RunScore = { points: number; rounds: number };

/** Seeded generator (mulberry32), so that an interval comes out the same every time. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const share = (runs: RunScore[]): number => {
  const rounds = runs.reduce((n, r) => n + r.rounds, 0);
  return rounds ? runs.reduce((n, r) => n + r.points, 0) / rounds : Number.NaN;
};

/** Wilson's score interval for points out of n rounds taken as independent. */
export function wilson(points: number, n: number, z = 1.96): [number, number] {
  if (!n) {
    return [Number.NaN, Number.NaN];
  }
  const p = points / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [centre - half, centre + half];
}

function percentile(sorted: number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/** Shares of `iterations` resamples of the runs (with replacement). */
function resampled(runs: RunScore[], iterations: number, next: () => number): number[] {
  const out: number[] = [];
  for (let k = 0; k < iterations; k++) {
    let points = 0;
    let rounds = 0;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[Math.floor(next() * runs.length)];
      points += r.points;
      rounds += r.rounds;
    }
    out.push(rounds ? points / rounds : Number.NaN);
  }
  return out;
}

/** 95% percentile interval of the share, resampling whole runs. */
export function bootstrapInterval(runs: RunScore[], iterations = 2000, seed = 20261006): [number, number] {
  if (runs.length < 2) {
    return [Number.NaN, Number.NaN];
  }
  const shares = resampled(runs, iterations, random(seed)).sort((x, y) => x - y);
  return [percentile(shares, 0.025), percentile(shares, 0.975)];
}

/**
 * Player a's share minus player b's, resampling each one's runs: the difference, its 95% interval,
 * and a two-sided p-value (twice the share of resamples on the far side of zero).
 */
export function bootstrapDifference(a: RunScore[], b: RunScore[], iterations = 2000, seed = 20261006): { difference: number; interval: [number, number]; p: number } {
  const next = random(seed);
  const sa = resampled(a, iterations, next);
  const sb = resampled(b, iterations, next);
  const diffs = sa.map((x, i) => x - sb[i]).sort((x, y) => x - y);
  const below = diffs.filter((d) => d <= 0).length / iterations;
  return { difference: share(a) - share(b), interval: [percentile(diffs, 0.025), percentile(diffs, 0.975)], p: Math.min(1, 2 * Math.min(below, 1 - below)) };
}

/** Holm-Bonferroni: adjusted p-values for a family of comparisons, in their own order. */
export function holm(ps: number[]): number[] {
  const order = ps.map((p, i) => [p, i] as const).sort((x, y) => x[0] - y[0]);
  const adjusted = new Array<number>(ps.length);
  let running = 0;
  order.forEach(([p, i], rank) => {
    running = Math.max(running, Math.min(1, (ps.length - rank) * p));
    adjusted[i] = running;
  });
  return adjusted;
}

/** Student's t for a two-sided 95% interval with df degrees of freedom (Cornish-Fisher past ten). */
export function t975(df: number): number {
  const table = [Number.NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228];
  if (df < table.length) {
    return table[Math.max(0, Math.floor(df))];
  }
  const z = 1.959964;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2) + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3);
}

/**
 * The mean of independent values (one per session: a skill track's gain, or its time to the goal)
 * with a 95% interval, the wider of Student's t and a bootstrap's: t assumes a normal mean, the
 * bootstrap does not, and neither is trusted alone with few sessions.
 */
export function meanInterval(values: number[], iterations = 2000, seed = 20261006): { mean: number; interval: [number, number] } {
  const n = values.length;
  const mean = n ? values.reduce((a, b) => a + b, 0) / n : Number.NaN;
  if (n < 2) {
    return { mean, interval: [Number.NaN, Number.NaN] };
  }
  const sd = Math.sqrt(values.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  const half = (t975(n - 1) * sd) / Math.sqrt(n);
  const next = random(seed);
  const means: number[] = [];
  for (let k = 0; k < iterations; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += values[Math.floor(next() * n)];
    }
    means.push(sum / n);
  }
  means.sort((x, y) => x - y);
  return { mean, interval: [Math.min(mean - half, percentile(means, 0.025)), Math.max(mean + half, percentile(means, 0.975))] };
}
