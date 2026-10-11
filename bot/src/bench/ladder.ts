// UO Bench's ratings: every player of a build on one scale, from every duel it played at its own
// speed, whoever the opponent (the scripted bot on the duel tracks, the frozen model on the
// sparring tracks, another model on a ladder track). A Bradley-Terry fit (Hunter's MM algorithm)
// gives each side a strength; ratings are on the Elo scale (400 log10), the scripted bot at 1000.
// Intervals come from a bootstrap over runs (a run's rounds go together), refitting every time.
import { random } from "./stats.ts";

/** One run between two sides: the points each took (a draw is half a point to each). */
export type Pairing = { a: string; b: string; aPoints: number; bPoints: number };

export type Rating = { player: string; rating: number; interval: [number, number]; rounds: number; opponents: number };

/**
 * Strengths by Hunter's MM iterations, with a weak prior (one drawn round against a virtual side of
 * strength 1 for every player) so that a side that never won, or never lost, still gets a finite one.
 */
export function bradleyTerry(pairings: Pairing[], iterations = 500): Map<string, number> {
  const players = [...new Set(pairings.flatMap((p) => [p.a, p.b]))];
  const strength = new Map(players.map((p) => [p, 1]));
  const wins = new Map(players.map((p) => [p, 0.5])); // the prior's half point
  const games = new Map<string, Map<string, number>>(players.map((p) => [p, new Map()]));
  for (const { a, b, aPoints, bPoints } of pairings) {
    wins.set(a, (wins.get(a) ?? 0) + aPoints);
    wins.set(b, (wins.get(b) ?? 0) + bPoints);
    const n = aPoints + bPoints;
    games.get(a)?.set(b, (games.get(a)?.get(b) ?? 0) + n);
    games.get(b)?.set(a, (games.get(b)?.get(a) ?? 0) + n);
  }
  for (let k = 0; k < iterations; k++) {
    let change = 0;
    for (const p of players) {
      const sp = strength.get(p) ?? 1;
      let denominator = 1 / (sp + 1); // the prior's round against the virtual side
      for (const [q, n] of games.get(p) ?? []) {
        denominator += n / (sp + (strength.get(q) ?? 1));
      }
      const next = (wins.get(p) ?? 0) / denominator;
      change = Math.max(change, Math.abs(Math.log(next / sp)));
      strength.set(p, next);
    }
    if (change < 1e-9) {
      break;
    }
  }
  return strength;
}

const elo = (s: number, anchor: number) => 1000 + 400 * Math.log10(s / anchor);

/**
 * Ratings of every side, the anchor (the scripted bot of the build, "rules@40 mage") at 1000; with
 * no anchor among the sides, their geometric mean is. 95% intervals from `iterations` bootstrap
 * resamples of the runs.
 */
export function ratings(pairings: Pairing[], anchor?: string, iterations = 400, seed = 20261011): Rating[] {
  const fit = (ps: Pairing[]) => {
    const s = bradleyTerry(ps);
    const values = [...s.values()];
    const base = anchor && s.has(anchor) ? (s.get(anchor) as number) : Math.exp(values.reduce((t, v) => t + Math.log(v), 0) / values.length);
    return new Map([...s].map(([p, v]) => [p, elo(v, base)]));
  };
  const point = fit(pairings);
  const next = random(seed);
  const samples = new Map<string, number[]>([...point.keys()].map((p) => [p, []]));
  for (let k = 0; k < iterations; k++) {
    const resample = pairings.map(() => pairings[Math.floor(next() * pairings.length)]);
    for (const [p, r] of fit(resample)) {
      samples.get(p)?.push(r);
    }
  }
  const rounds = new Map<string, number>();
  const opponents = new Map<string, Set<string>>();
  for (const { a, b, aPoints, bPoints } of pairings) {
    for (const [p, q] of [[a, b], [b, a]]) {
      rounds.set(p, (rounds.get(p) ?? 0) + aPoints + bPoints);
      opponents.set(p, (opponents.get(p) ?? new Set()).add(q));
    }
  }
  const pct = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(q * (xs.length - 1))))];
  return [...point]
    .map(([player, rating]) => {
      // A side missing from a resample (all its runs left out) has no rating there.
      const xs = (samples.get(player) ?? []).sort((x, y) => x - y);
      return {
        player,
        rating,
        interval: xs.length >= 20 ? ([pct(xs, 0.025), pct(xs, 0.975)] as [number, number]) : ([Number.NaN, Number.NaN] as [number, number]),
        rounds: rounds.get(player) ?? 0,
        opponents: opponents.get(player)?.size ?? 0,
      };
    })
    .sort((x, y) => y.rating - x.rating);
}
