// The duel as typed questions, and the guardrails that turn answers into a legal plan.
import { castDelayMs } from "../game/caster.ts";
import { WEAPONS } from "../game/items.ts";
import type { Grid } from "../world/grid.ts";
import { spell } from "../uo/spells.ts";
import type { ChoiceQuestion } from "./systemone.ts";
import { SPELLBOOK } from "./spellbook.ts";
import { NEUTRAL, type Tactics, applyBands } from "./tactics.ts";
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

/**
 * Versions of the text a model reads and of the options it is offered. Bump one whenever it
 * changes: every run and every label records them, so data made with different formats never mix
 * unnoticed.
 */
export const FORMAT = { describe: "duel-2", question: "composite-3" } as const;

/** Out of range or out of sight no spell reaches them, so an attack means getting there. */
export const isOutOfReach = (s: DuelSnapshot) => (!s.them.inRange || !s.them.inLineOfSight) && !s.them.dead;

/** After our cast the bot answers the target cursor at once; this covers the round trip. */
const TARGET_MS = 100;

/** Protection costs 2 points of casting speed under AOS rules: 0.5 s on every cast (Spell.GetCastDelay). */
export const PROTECTION_SLOWDOWN_MS = 500;

/** How long a cast of ours takes now: slower under our own Protection. */
const ourCastMs = (key: string, s: DuelSnapshot) => castDelayMs(spell(key)) + (s.us.protection ? PROTECTION_SLOWDOWN_MS : 0);

/**
 * Whether our spell would hit while theirs is still being cast. Damage and curses break a spell
 * only then (ModernUO's Spell.OnCasterHurt checks IsCasting); after that it is on its way.
 */
export const landsFirst = (key: string, s: DuelSnapshot) =>
  s.them.casting !== null && s.them.landsInMs >= s.us.readyInMs + ourCastMs(key, s) + TARGET_MS;

const CHASE_TEXT = "walk towards them (or Teleport next to them when a tile is in reach) until they are in range and in sight";

/**
 * Their spells that break a cast of ours, and when after their cast ends: damage on landing, and
 * the curses that call OnCasterHurt (ModernUO). Explosion's damage follows 3 s later under AOS
 * rules (2.5 s before); Paralyze and heals break nothing.
 */
const DISTURB_DELAY_MS: Record<string, number> = {
  magicArrow: 0, harm: 0, fireball: 0, lightning: 0, energyBolt: 0, mindBlast: 1_000, flamestrike: 0,
  poison: 0, curse: 0, weaken: 0, clumsy: 0, feeblemind: 0, explosion: 3_000,
};

/** Whether a spell of theirs, once it lands, breaks a cast of ours. */
export const breaksCasts = (spellKey: string) => spellKey in DISTURB_DELAY_MS;

/** When their current cast breaks ours, if it does. */
export const disturbsInMs = (s: DuelSnapshot) =>
  s.them.casting && s.them.casting in DISTURB_DELAY_MS ? s.them.landsInMs + DISTURB_DELAY_MS[s.them.casting] : Number.POSITIVE_INFINITY;

/**
 * A cast of ours that their spell would break: it lands while ours is still being cast. Under our
 * own Protection nothing breaks it (AOS rules: ProtectionSpell.Registry holds 100%).
 */
export const doomed = (key: string, s: DuelSnapshot) => {
  if (s.us.protection) {
    return false;
  }
  const at = disturbsInMs(s);
  return at > s.us.readyInMs && at < s.us.readyInMs + ourCastMs(key, s);
};

/** About one running step: a dodge must reach its tile before they aim. */
const STEP_MS = 200;

const HOLD_TEXT = "wait for their spell to land, then cast at once: anything cast now would be broken";
const DODGE_TEXT = "step behind cover or out of their range before their spell lands, so it cannot be aimed at you";

/** Reagents per spell, from the spellbook (ModernUO's SpellInfo). */
const REAGENTS: Record<string, string[]> = Object.fromEntries(Object.entries(SPELLBOOK).map(([k, v]) => [k, v.reagents]));

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
  energyBolt: "Corp Por: heavy energy hit, 20 mana, 2.0 s to cast",
  mindBlast: "Por Corp Wis: hit of (Magery + Int) / 5, lands 1 s after the cast, 14 mana, 1.75 s",
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
  protection: "Uus Sanct: your casts are broken less often by their hits, for a little physical resistance; casting it again takes it off",
  magicReflection: "In Jux Sanct: +10 fire, cold, poison and energy resistance for -20 physical; casting it again takes it off",
};

const pct = (value: number, max: number) => (max > 0 ? Math.round((100 * value) / max) : 0);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * What the opponent wields and whether they are under Protection, when either matters (duel-2).
 * Against a caster without Protection it says nothing, so the text stays as duel-1 wrote it and
 * the labels asked with duel-1 still hold.
 */
function opponentKit(them: DuelSnapshot["them"]): string {
  const parts: string[] = [];
  if (them.weapon) {
    const ranged = Object.values(WEAPONS).find((w) => w.name === them.weapon)?.ranged;
    parts.push(
      ranged
        ? `shooting a ${them.weapon} (ranged: they hit from afar and do not cast)`
        : `wielding a ${them.weapon} (melee: next to you their hits break your spells unless you are under Protection)`,
    );
  }
  if (them.protection) {
    parts.push("under Protection (your hits cannot break their spells)");
  }
  return parts.map((p) => `${p}, `).join("");
}

/** The duel state as short English text: what the model reads. */
export function describeDuel(s: DuelSnapshot): string {
  const { us, them } = s;
  const lines = [
    `Ultima Online mage duel, one on one. You are ${us.name}; your opponent is ${them.name}.`,
    `${us.name}: health ${us.hits}/${us.hitsMax} (${pct(us.hits, us.hitsMax)}%), mana ${us.mana}/${us.manaMax}, ` +
      `${us.poisoned ? "POISONED" : "not poisoned"}, ` +
      (us.readyInMs > 0 ? `recovering from ${us.lastSpell ?? "a spell"} for ${seconds(us.readyInMs)}.` : "ready to cast now."),
    `${them.name}: health ${them.healthPct}%, ${them.poisoned ? "POISONED" : "not poisoned"}, ` +
      opponentKit(them) +
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
/**
 * The legal options narrowed by a person's tactics: no chase past the chase limits, and the
 * health bands on heals and retreats. With neutral tactics these are the legal options.
 */
export function tacticalOptions(s: DuelSnapshot, t: Tactics = NEUTRAL): { options: string[]; notes: string[] } {
  let options = legalOptions(s);
  const notes: string[] = [];
  if (options.includes("damage:chase")) {
    const tooFar = s.them.distance > t.chase.maxTiles;
    const tooLong = (s.us.outOfReachForMs ?? 0) > t.chase.giveUpSeconds * 1000;
    if (tooFar || tooLong) {
      options = options.filter((k) => k !== "damage:chase");
      notes.push(tooFar ? `no chase past ${t.chase.maxTiles} tiles` : `chase given up after ${t.chase.giveUpSeconds} s`);
    }
  }
  const banded = applyBands(options, pct(s.us.hits, s.us.hitsMax), t);
  if (banded.note) {
    notes.push(banded.note);
  }
  return { options: banded.options, notes };
}

export function compositeQuestion(s: DuelSnapshot, t: Tactics = NEUTRAL): Record<string, ChoiceQuestion> {
  const text = (mode: Mode, key: string) =>
    key === "chase"
      ? CHASE_TEXT
      : key === "hold"
        ? HOLD_TEXT
        : key === "dodge"
          ? DODGE_TEXT
          : mode === "damage"
        ? DAMAGE_CRITERIA[key]
        : mode === "interrupt"
          ? INTERRUPT_CRITERIA[key]
          : DEFENSE_CRITERIA[key];
  const criteria: Record<string, string> = {};
  for (const option of tacticalOptions(s, t).options) {
    const [mode, key] = option.split(":") as [Mode, string];
    criteria[option] = `${MODE_LABEL[mode]}: ${text(mode, key)}`;
  }
  return {
    move: { type: "choice", instructions: `What should ${s.us.name} do next?`, criteria },
  };
}

const normalize = (p: Record<string, number>): Distribution => {
  const total = Object.values(p).reduce((a, b) => a + b, 0) || 1;
  const probabilities = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v / total]));
  // A mode can be empty now that questions offer only legal options.
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
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

/** A spell we cannot cast at all for now: not in the book, too little mana, or a reagent gone. */
function lacksMeans(key: string, s: DuelSnapshot): boolean {
  const sp = spell(key);
  return (
    (s.us.spells !== undefined && !s.us.spells.includes(key)) ||
    s.us.mana < sp.mana ||
    (REAGENTS[key] ?? []).some((r) => (s.reagents[r] ?? 0) < 1)
  );
}

/** Why an option cannot be used right now, or null if it can. */
export function blocked(key: string, s: DuelSnapshot): string | null {
  if (key === "chase") {
    return isOutOfReach(s) ? null : `${s.them.name} is already in range and in sight`;
  }
  if (key === "hold") {
    return Number.isFinite(disturbsInMs(s)) ? null : "nothing of theirs to wait for";
  }
  if (key === "dodge") {
    const steps = s.us.coverSteps;
    return !s.them.casting || !(s.them.casting in DISTURB_DELAY_MS)
      ? "nothing to dodge"
      : steps === undefined || steps * STEP_MS >= s.them.landsInMs
        ? "no cover or edge of range close enough"
        : null;
  }
  if (key === "retreat") {
    const hurt = s.us.hits < s.us.hitsMax * 0.8 || s.us.poisoned;
    // Out of reagents or mana for every attack (not merely waiting out their spell), running is all that is left.
    const unarmed = DAMAGE_SPELLS.every((k) => k === "teleport" || lacksMeans(k, s));
    return !hurt && !unarmed
      ? "healthy enough to stand and fight"
      : s.them.distance > SPELL_RANGE + 2
        ? "already out of reach"
        : null;
  }
  if (s.us.spells && !s.us.spells.includes(key)) {
    return "not in your spellbook";
  }
  if (s.us.offer && !s.us.offer.includes(key)) {
    return "not in this profile's list";
  }
  const sp = spell(key);
  if (s.us.mana < sp.mana) {
    return `not enough mana for ${sp.name}`;
  }
  const missing = (REAGENTS[key] ?? []).filter((r) => (s.reagents[r] ?? 0) < 1);
  if (missing.length) {
    return `out of ${missing.join(", ")}`;
  }
  if (doomed(key, s)) {
    return `${spell(s.them.casting ?? "").name} breaks it in ${seconds(disturbsInMs(s))}, before ${sp.name} is cast`;
  }
  switch (key) {
    case "protection":
    case "magicReflection":
      return s.us[key] ? `${sp.name} is already on; casting it again would take it off` : null;
    case "cure":
      return s.us.poisoned ? null : "not poisoned";
    case "heal":
    case "greaterHeal":
      return s.us.hits >= s.us.hitsMax ? "already at full health" : null;
    case "poison":
      return s.them.poisoned ? `${s.them.name} is already poisoned` : null;
    case "teleport":
      return s.them.distance <= 2
        ? "already close"
        : s.tiles.length === 0
          ? `no free tile next to ${s.them.name} within ${SPELL_RANGE} tiles`
          : null;
  }
  if (sp.harmful && !s.them.inRange) {
    return "out of range";
  }
  if (sp.harmful && !s.them.inLineOfSight) {
    return "out of sight";
  }
  return null;
}

/** blocked, plus what the mode asks of the move: an interrupt has to land before their spell. */
export function blockedAs(mode: Mode, key: string, s: DuelSnapshot): string | null {
  const reason = blocked(key, s);
  if (reason || mode !== "interrupt") {
    return reason;
  }
  if (!s.them.casting) {
    return `${s.them.name} is not casting`;
  }
  if (s.them.protection) {
    return `${s.them.name} is under Protection: hits do not break their spells`;
  }
  return landsFirst(key, s)
    ? null
    : `${spell(s.them.casting).name} lands in ${seconds(s.them.landsInMs)}, before ${spell(key).name} could`;
}

/**
 * The moves the question offers (composite-2), only those the bot can make now: out of reach,
 * chasing or a move on yourself; an interrupt only while it would land first.
 */
export function legalOptions(s: DuelSnapshot): string[] {
  const keys: string[] = [];
  if (isOutOfReach(s)) {
    keys.push("damage:chase");
  } else {
    keys.push(...DAMAGE_SPELLS.filter((k) => !blocked(k, s)).map((k) => `damage:${k}`));
    keys.push(...INTERRUPT_SPELLS.filter((k) => !blockedAs("interrupt", k, s)).map((k) => `interrupt:${k}`));
  }
  keys.push(...DEFENSE_SPELLS.filter((k) => !blocked(k, s)).map((k) => `defense:${k}`));
  // Waiting pays only when their spell would break a cast of ours; dodging, when cover is in reach.
  const casts = [...DAMAGE_SPELLS, ...DEFENSE_SPELLS].filter((k) => k !== "retreat");
  if (!isOutOfReach(s) && casts.some((k) => doomed(k, s)) && !blocked("hold", s)) {
    keys.push("defense:hold");
  }
  if (!blocked("dodge", s)) {
    keys.push("defense:dodge");
  }
  return keys;
}

/** Highest-probability usable option; notes when that differs from the raw choice. */
export function pick(d: Distribution, s: DuelSnapshot, overrides: string[], mode: Mode = "damage"): string | null {
  const ranked = Object.entries(d.probabilities).sort((a, b) => b[1] - a[1]);
  for (const [key] of ranked) {
    const reason = blockedAs(mode, key, s);
    if (!reason) {
      if (key !== d.choice) {
        overrides.push(`${d.choice} → ${key} (${blockedAs(mode, d.choice, s)})`);
      }
      return key;
    }
  }
  overrides.push(`no usable option (${d.choice ? blockedAs(mode, d.choice, s) : "none offered"})`);
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
  t: Tactics = NEUTRAL,
): { plan: Plan; why: string } {
  // Out of range or out of sight an attack means chasing: teleport next to them if a tile is in
  // reach, otherwise run closer. Defensive moves still work there, so a hurt bot that ran away
  // or hid can heal instead of being pulled straight back.
  const chase = (): { plan: Plan; why: string } => {
    const target = tile ? s.tiles.find((x) => x.id === tile.choice) : s.tiles[0];
    if (target && t.chase.teleport && !blocked("teleport", s)) {
      return { plan: { kind: "teleport", tile: target }, why: `out of range; ${target.label}` };
    }
    return { plan: { kind: "approach" }, why: `${s.them.name} is out of spell range; closing in` };
  };
  const outOfReach = isOutOfReach(s);
  // The tactics may rule the chase out (too far, or given up): then only moves on yourself remain.
  const mayChase = outOfReach && tacticalOptions(s, t).options.includes("damage:chase");

  const modes = (Object.entries(mode.probabilities) as [Mode, number][]).sort((a, b) => b[1] - a[1]);
  for (const [m] of modes) {
    if (m === "interrupt" && !s.them.casting) {
      if (m === mode.choice) {
        overrides.push(`interrupt → next mode (${s.them.name} is not casting)`);
      }
      continue;
    }
    if (outOfReach && m !== "defense") {
      if (mayChase) {
        return chase();
      }
      continue;
    }
    const key = pick(byMode[m], s, overrides, m);
    if (!key) {
      continue;
    }
    if (m !== mode.choice && !overrides.some((o) => o.startsWith(mode.choice))) {
      overrides.push(`${mode.choice} → ${m}`);
    }
    if (key === "retreat") {
      return { plan: { kind: "retreat" }, why: DEFENSE_CRITERIA.retreat };
    }
    if (key === "chase") {
      return chase();
    }
    if (key === "hold") {
      return { plan: { kind: "wait", ms: Math.max(100, Math.min(3_500, disturbsInMs(s) + 100)), hold: true }, why: HOLD_TEXT };
    }
    if (key === "dodge") {
      return { plan: { kind: "retreat" }, why: DODGE_TEXT };
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
  if (mayChase) {
    return chase();
  }
  if (outOfReach) {
    return { plan: { kind: "wait", ms: 300 }, why: `${s.them.name} is out of reach and the tactics say not to chase` };
  }
  return { plan: { kind: "wait", ms: 300 }, why: "nothing castable right now; waiting for mana" };
}

/**
 * Teleport candidates: free tiles next to the opponent, nearest to us first. Teleport targets a
 * tile like any targeted spell, so only tiles within SPELL_RANGE and in sight count (ModernUO: 10
 * from T2A on).
 */
export function teleportTiles(s: Pick<DuelSnapshot, "us" | "them">, grid?: Grid): DuelSnapshot["tiles"] {
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
      if (fromUs === 0 || fromUs > SPELL_RANGE) {
        continue;
      }
      // The target tile must be free and in our sight, like any spell target.
      if (grid && (grid.isBlocked({ x, y }) || !grid.lineOfSight(us, { x, y }))) {
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

export type RawAnswers = { mode: Distribution; damage: Distribution; interrupt: Distribution; defense: Distribution; tile?: Distribution };
