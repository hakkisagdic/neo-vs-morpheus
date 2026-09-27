// The duel as typed questions, and the guardrails that turn answers into a legal plan.
import { spell } from "../uo/spells.ts";
import type { ChoiceQuestion } from "./systemone.ts";
import {
  DAMAGE_SPELLS,
  DEFENSE_SPELLS,
  type Decision,
  type Distribution,
  type DuelSnapshot,
  INTERRUPT_SPELLS,
  type Mode,
  type Plan,
} from "./types.ts";

/** Magery range in ML-era rules. */
export const SPELL_RANGE = 10;

const REAGENTS: Record<string, string[]> = {
  magicArrow: ["sulfurousAsh"],
  heal: ["garlic", "ginseng", "spidersSilk"],
  weaken: ["garlic", "nightshade"],
  harm: ["nightshade", "spidersSilk"],
  cure: ["garlic", "ginseng"],
  poison: ["nightshade"],
  teleport: ["bloodmoss", "mandrakeRoot"],
  curse: ["garlic", "nightshade", "sulfurousAsh"],
  greaterHeal: ["garlic", "ginseng", "mandrakeRoot", "spidersSilk"],
  lightning: ["mandrakeRoot", "sulfurousAsh"],
  paralyze: ["garlic", "mandrakeRoot", "spidersSilk"],
  explosion: ["bloodmoss", "mandrakeRoot"],
  flamestrike: ["spidersSilk", "sulfurousAsh"],
};

// Option descriptions double as the model's criteria and the monitor's "why".
const DAMAGE_CRITERIA: Record<string, string> = {
  poison: "In Nox: poisons them for steady damage over time; pointless if they are already poisoned",
  explosion: "Vas Ort Flam: heavy hit, 20 mana, 2.0 s to cast",
  lightning: "Por Ort Grav: solid instant hit, 11 mana, 1.5 s to cast",
  teleport: "Rel Por: jump next to them to close the distance",
  harm: "An Mani: quick 1.0 s hit that is strongest at close range",
  flamestrike: "Kal Vas Flam: the biggest hit, 40 mana, 2.25 s to cast",
  magicArrow: "In Por Ylem: fastest 0.75 s small hit, 4 mana",
  curse: "Des Sanct: lowers their stats and resistances before the big hits",
  paralyze: "An Ex Por: freezes them so they cannot move for a few seconds",
};

const INTERRUPT_CRITERIA: Record<string, string> = {
  harm: "An Mani: 1.0 s, hits hardest when adjacent",
  weaken: "Des Mani: 0.75 s, cheap and harmless but still breaks a spell",
  magicArrow: "In Por Ylem: 0.75 s, small damage that breaks their spell",
};

const DEFENSE_CRITERIA: Record<string, string> = {
  heal: "In Mani: small quick heal, 0.75 s",
  greaterHeal: "In Vas Mani: large heal, 1.5 s, 11 mana",
  cure: "An Nox: removes poison",
  retreat: "run out of their spell range to heal and wait out poison safely",
};

const pct = (value: number, max: number) => (max > 0 ? Math.round((100 * value) / max) : 0);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The duel state as short English text: what the model reads. */
export function describeDuel(s: DuelSnapshot): string {
  const { us, them } = s;
  const lines = [
    `Ultima Online mage duel, one on one. You are ${us.name}; your opponent is ${them.name}.`,
    `${us.name}: health ${us.hits}/${us.hitsMax} (${pct(us.hits, us.hitsMax)}%), mana ${us.mana}/${us.manaMax}, ` +
      `${us.poisoned ? "POISONED" : "not poisoned"}, ` +
      (us.readyInMs > 0 ? `recovering from ${us.lastSpell ?? "a spell"} for ${seconds(us.readyInMs)}.` : "ready to cast now."),
    `${them.name}: health ${them.healthPct}%, ${them.poisoned ? "POISONED" : "not poisoned"}, ` +
      (them.casting
        ? `casting ${spell(them.casting).name} (lands in about ${seconds(them.landsInMs)}), `
        : "not casting, ") +
      `${them.distance} tiles away, ${them.inLineOfSight ? "in line of sight" : "out of sight"}, ` +
      `${them.inRange ? "within spell range" : "out of spell range"}.`,
  ];
  const lowRegs = Object.entries(s.reagents)
    .filter(([, n]) => n < 5)
    .map(([k]) => k);
  if (lowRegs.length) {
    lines.push(`Low on reagents: ${lowRegs.join(", ")}.`);
  }
  if (s.recent.length) {
    lines.push(`Recent: ${s.recent.slice(-4).join("; ")}.`);
  }
  return lines.join("\n");
}

export function duelQuestions(s: DuelSnapshot): Record<string, ChoiceQuestion> {
  const { us, them } = s;
  const questions: Record<string, ChoiceQuestion> = {
    nextAction: {
      type: "choice",
      instructions: `What should ${us.name} do next?`,
      criteria: {
        damage: `attack ${them.name} with a damaging spell`,
        interrupt: `${them.name} is casting; hit them with a fast spell to break it before it lands`,
        defense: `${us.name} is poisoned or hurt; cure or heal first`,
      },
    },
    damageSpell: {
      type: "choice",
      instructions: `Which spell should ${us.name} cast to hurt ${them.name}?`,
      criteria: Object.fromEntries(DAMAGE_SPELLS.map((k) => [k, DAMAGE_CRITERIA[k]])),
    },
    interruptSpell: {
      type: "choice",
      instructions: `Which fast spell best breaks ${them.name}'s cast?`,
      criteria: Object.fromEntries(INTERRUPT_SPELLS.map((k) => [k, INTERRUPT_CRITERIA[k]])),
    },
    defenseSpell: {
      type: "choice",
      instructions: `Which spell should ${us.name} cast on themself?`,
      criteria: Object.fromEntries(DEFENSE_SPELLS.map((k) => [k, DEFENSE_CRITERIA[k]])),
    },
  };
  if (s.tiles.length > 0) {
    questions.teleportTile = {
      type: "choice",
      instructions: `If ${us.name} teleports, which tile is best?`,
      criteria: Object.fromEntries(s.tiles.map((t) => [t.id, t.label])),
    };
  }
  return questions;
}

const MODE_LABEL: Record<Mode, string> = {
  damage: "attack",
  interrupt: "break their cast",
  defense: "on yourself",
};

/**
 * All three modes as one question ("damage:poison", "defense:cure", ...): one forward pass
 * instead of four, which matters on a CPU-only backend. `splitComposite` recovers the per-mode
 * distributions the monitor shows.
 */
export function compositeQuestion(s: DuelSnapshot): Record<string, ChoiceQuestion> {
  const criteria: Record<string, string> = {};
  const add = (mode: Mode, keys: readonly string[], text: Record<string, string>) => {
    for (const k of keys) {
      criteria[`${mode}:${k}`] = `${MODE_LABEL[mode]}: ${text[k]}`;
    }
  };
  add("damage", DAMAGE_SPELLS, DAMAGE_CRITERIA);
  add("interrupt", INTERRUPT_SPELLS, INTERRUPT_CRITERIA);
  add("defense", DEFENSE_SPELLS, DEFENSE_CRITERIA);
  return {
    move: { type: "choice", instructions: `Which spell should ${s.us.name} cast next?`, criteria },
  };
}

const normalize = (p: Record<string, number>): Distribution => {
  const total = Object.values(p).reduce((a, b) => a + b, 0) || 1;
  const probabilities = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v / total]));
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { choice, probabilities };
};

/** Mode = sum of its options; each mode's spells = its options renormalised. */
export function splitComposite(d: Distribution): Record<Mode | "mode", Distribution> {
  const byMode: Record<Mode, Record<string, number>> = { damage: {}, interrupt: {}, defense: {} };
  for (const [key, p] of Object.entries(d.probabilities)) {
    const [mode, spellKey] = key.split(":") as [Mode, string];
    byMode[mode][spellKey] = p;
  }
  const modeTotals = Object.fromEntries(
    (Object.keys(byMode) as Mode[]).map((m) => [m, Object.values(byMode[m]).reduce((a, b) => a + b, 0)]),
  );
  return {
    mode: normalize(modeTotals),
    damage: normalize(byMode.damage),
    interrupt: normalize(byMode.interrupt),
    defense: normalize(byMode.defense),
  };
}

/** Why an option cannot be used right now, or null if it can. */
export function blocked(key: string, s: DuelSnapshot): string | null {
  if (key === "retreat") {
    const hurt = s.us.hits < s.us.hitsMax * 0.8 || s.us.poisoned;
    return !hurt ? "healthy enough to stand and fight" : s.them.distance > SPELL_RANGE + 2 ? "already out of reach" : null;
  }
  const sp = spell(key);
  if (s.us.mana < sp.mana) {
    return `not enough mana for ${sp.name}`;
  }
  const missing = (REAGENTS[key] ?? []).filter((r) => (s.reagents[r] ?? 0) < 1);
  if (missing.length) {
    return `out of ${missing.join(", ")}`;
  }
  switch (key) {
    case "cure":
      return s.us.poisoned ? null : "not poisoned";
    case "heal":
    case "greaterHeal":
      return s.us.hits >= s.us.hitsMax ? "already at full health" : null;
    case "poison":
      return s.them.poisoned ? `${s.them.name} is already poisoned` : null;
    case "teleport":
      return s.tiles.length === 0 || s.them.distance <= 2 ? "already close" : null;
  }
  if (sp.harmful && !s.them.inRange) {
    return "out of range";
  }
  return null;
}

/** Highest-probability usable option; notes when that differs from the raw choice. */
export function pick(d: Distribution, s: DuelSnapshot, overrides: string[]): string | null {
  const ranked = Object.entries(d.probabilities).sort((a, b) => b[1] - a[1]);
  for (const [key] of ranked) {
    const reason = blocked(key, s);
    if (!reason) {
      if (key !== d.choice) {
        overrides.push(`${d.choice} → ${key} (${blocked(d.choice, s)})`);
      }
      return key;
    }
  }
  overrides.push(`no usable option (${blocked(d.choice, s)})`);
  return null;
}

const modeOptions: Record<Mode, readonly string[]> = {
  damage: DAMAGE_SPELLS,
  interrupt: INTERRUPT_SPELLS,
  defense: DEFENSE_SPELLS,
};

/** Turns the four distributions into a legal plan, walking down the modes by probability. */
export function resolvePlan(
  s: DuelSnapshot,
  mode: Distribution,
  byMode: Record<Mode, Distribution>,
  tile: Distribution | undefined,
  overrides: string[],
): { plan: Plan; why: string } {
  if (!s.them.inRange && !s.them.dead) {
    const t = tile ? s.tiles.find((x) => x.id === tile.choice) : s.tiles[0];
    if (t && !blocked("teleport", s)) {
      return { plan: { kind: "teleport", tile: t }, why: `out of range; ${t.label}` };
    }
    return { plan: { kind: "approach" }, why: `${s.them.name} is out of spell range; closing in` };
  }

  const modes = (Object.entries(mode.probabilities) as [Mode, number][]).sort((a, b) => b[1] - a[1]);
  for (const [m] of modes) {
    if (m === "interrupt" && !s.them.casting) {
      if (m === mode.choice) {
        overrides.push(`interrupt → next mode (${s.them.name} is not casting)`);
      }
      continue;
    }
    const key = pick(byMode[m], s, overrides);
    if (!key) {
      continue;
    }
    if (m !== mode.choice && !overrides.some((o) => o.startsWith(mode.choice))) {
      overrides.push(`${mode.choice} → ${m}`);
    }
    if (key === "retreat") {
      return { plan: { kind: "retreat" }, why: DEFENSE_CRITERIA.retreat };
    }
    if (key === "teleport") {
      const t = tile ? s.tiles.find((x) => x.id === tile.choice) : s.tiles[0];
      if (t) {
        return { plan: { kind: "teleport", tile: t }, why: t.label };
      }
      continue;
    }
    const target = m === "defense" ? "self" : "them";
    const why =
      m === "defense" ? DEFENSE_CRITERIA[key] : m === "interrupt" ? INTERRUPT_CRITERIA[key] : DAMAGE_CRITERIA[key];
    return { plan: { kind: "cast", spell: key, target }, why };
  }
  return { plan: { kind: "wait", ms: 300 }, why: "nothing castable right now; waiting for mana" };
}

/** Teleport candidates: free tiles next to the opponent, nearest to us first. */
export function teleportTiles(s: Pick<DuelSnapshot, "us" | "them">): DuelSnapshot["tiles"] {
  const { us, them } = s;
  const tiles: DuelSnapshot["tiles"] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const x = them.x + dx;
      const y = them.y + dy;
      const fromUs = Math.max(Math.abs(x - us.x), Math.abs(y - us.y));
      if (fromUs === 0 || fromUs > 12) {
        continue;
      }
      tiles.push({ id: "", x, y, z: them.z, label: "" });
    }
  }
  tiles.sort((a, b) => dist(a, us) - dist(b, us));
  return tiles.slice(0, 4).map((t, i) => ({
    ...t,
    id: `p${i + 1}`,
    label: `next to ${them.name} - ${dist(t, us)} tiles from you; a Teleport here puts ${them.name} in reach of Harm`,
  }));
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export type RawAnswers = Pick<Decision, "mode" | "damage" | "interrupt" | "defense"> & { tile?: Distribution };
