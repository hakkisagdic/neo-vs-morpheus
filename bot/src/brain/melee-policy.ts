// Fighters (swordsmen, archers): the duel as text, one composite question over every move, the
// guardrails that keep a choice legal, and the scripted baseline. The mage has its own in
// duel-policy.ts; both answer the same kind of question, "mode:option".
import { ABILITIES, type AbilityName } from "../game/items.ts";
import type { ChoiceQuestion } from "./systemone.ts";
import type { Distribution, DuelSnapshot, Plan } from "./types.ts";
import { NEUTRAL, type Tactics, applyBands } from "./tactics.ts";

/**
 * Versions of the text and options (see FORMAT in duel-policy.ts). melee-3 adds the fighter's skills
 * when any is below 100 and what a creature opponent is; a duel between full-skill fighters reads as
 * melee-2 wrote it, so the labels asked with melee-2 still hold. A model reads the text it learned:
 * the champions up to 2026-10-15 learned melee-2, so melee-3 is written only where MELEE_DESCRIBE=melee-3
 * says so (training data for a melee-3 model, and that model once it plays).
 */
export type MeleeDescribe = "melee-2" | "melee-3";
const DESCRIBE: MeleeDescribe = process.env.MELEE_DESCRIBE === "melee-3" ? "melee-3" : "melee-2";
export const MELEE_FORMAT = { describe: DESCRIBE, question: "melee-2" } as const;

/** The skills a fighter's text names, by UO's 0-based skill id. */
export const COMBAT_SKILLS: Readonly<Record<number, string>> = {
  40: "Swordsmanship",
  41: "Mace Fighting",
  42: "Fencing",
  31: "Archery",
  43: "Wrestling",
  27: "Tactics",
  1: "Anatomy",
  17: "Healing",
  5: "Parrying",
};

/** The skill a weapon uses (none: Wrestling). */
export function weaponSkill(w: { name: string; ranged: boolean } | null | undefined): string {
  if (!w) {
    return "Wrestling";
  }
  if (w.ranged) {
    return "Archery";
  }
  if (/kryss|fork|spear|pike|dagger|lance/i.test(w.name)) {
    return "Fencing";
  }
  if (/mace|hammer|club|staff|maul|scepter|axe of/i.test(w.name)) {
    return "Mace Fighting";
  }
  return "Swordsmanship";
}

/** "Your skills: Swordsmanship 50, …" while any of the fighter's skills is below 100; nothing at full skill. */
function skillsLine(s: DuelSnapshot): string {
  const skills = s.us.skills;
  if (!skills) {
    return "";
  }
  // Skills a fighter has (an archer's Parrying at 0 is no part of it).
  const named = [weaponSkill(s.us.weapon), "Tactics", "Anatomy", "Healing", "Parrying"].filter((k) => (skills[k] ?? 0) > 0);
  if (!named.length || named.every((k) => Math.round(skills[k] ?? 0) >= 100)) {
    return "";
  }
  return `Your skills: ${named.map((k) => `${k} ${Math.round(skills[k] ?? 0)}`).join(", ")}.`;
}

/** ", a creature that attacks on sight: a fight would cost you about 28% of your health (danger low)". */
function creatureClause(s: DuelSnapshot): string {
  const c = s.them.creature;
  if (!c) {
    return "";
  }
  const kind = `a creature${c.caster ? " that casts spells" : ""}${c.attacksOnSight ? ", attacks on sight" : ""}`;
  return `, ${kind}: a fight would cost you about ${Math.round(100 * c.loss)}% of your health now (danger ${c.danger})`;
}

export const MELEE_MODES = ["attack", "heal", "cure", "refresh", "throw", "move"] as const;

const pct = (value: number, max: number) => (max > 0 ? Math.round((100 * value) / max) : 0);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const camelToWords = (s: string) => s.replace(/([A-Z])/g, " $1").toLowerCase();

/** Tiles from which our weapon reaches them (bare hands: 1). */
export const reach = (s: DuelSnapshot) => s.us.weapon?.range ?? 1;
const inReach = (s: DuelSnapshot) => s.them.distance <= reach(s) && s.them.inLineOfSight;

/** Mana for an ability right now: double within 3 s of the previous one. */
function abilityCost(s: DuelSnapshot, which: "primary" | "secondary"): number {
  const w = s.us.weapon;
  if (!w) {
    return Number.POSITIVE_INFINITY;
  }
  const base = which === "primary" ? w.primaryMana : w.secondaryMana;
  return (s.us.lastAbilityAgoMs ?? Number.POSITIVE_INFINITY) < 3_000 ? base * 2 : base;
}

export function describeMelee(s: DuelSnapshot, describe: MeleeDescribe = MELEE_FORMAT.describe): string {
  const { us, them } = s;
  const w = us.weapon;
  const sup = s.supplies;
  const hp = pct(us.hits, us.hitsMax);
  const stam = pct(us.stam, us.stamMax);
  const self = [
    `health ${us.hits}/${us.hitsMax} (${hp}%${hp <= 40 ? ", in danger" : ""})`,
    `stamina ${us.stam}/${us.stamMax}${stam <= 25 ? " (exhausted: slow swings, can hardly run)" : ""}`,
    `mana ${us.mana}/${us.manaMax}`,
    us.poisoned ? "POISONED" : "not poisoned",
    (us.bandagingForMs ?? 0) > 0 ? `bandaging, ${seconds(us.bandagingForMs ?? 0)} to go` : "not bandaging",
  ];
  if (us.freeHand !== false && (sup?.healPotions ?? 0) > 0) {
    self.push((us.healPotionReadyInMs ?? 0) > 0 ? `heal potion ready in ${seconds(us.healPotionReadyInMs ?? 0)}` : "heal potion ready");
  }
  const lines = [
    `Ultima Online duel, one on one. You are ${us.name}, ${w ? `fighting with a ${w.name}${w.ranged ? " (ranged)" : ""}` : "unarmed"}; your opponent is ${them.name}${describe === "melee-3" ? creatureClause(s) : ""}.`,
    `${us.name}: ${self.join(", ")}.`,
  ];
  const skills = describe === "melee-3" ? skillsLine(s) : "";
  if (skills) {
    lines.push(skills);
  }
  if (sup) {
    const carried = [
      sup.bandages ? `${sup.bandages} bandages` : "",
      sup.healPotions ? `${sup.healPotions} heal` : "",
      sup.curePotions ? `${sup.curePotions} cure` : "",
      sup.refreshPotions ? `${sup.refreshPotions} refresh` : "",
      sup.explosionPotions ? `${sup.explosionPotions} explosion` : "",
    ].filter(Boolean);
    const potions = carried.filter((c) => !c.endsWith("bandages"));
    const text = [carried.find((c) => c.endsWith("bandages")), potions.length ? `${potions.join(", ")} potions` : ""]
      .filter(Boolean)
      .join("; ");
    lines.push(`Supplies: ${text || "none"}${w?.ranged ? `; ${sup.arrows} arrows` : ""}.`);
  }
  lines.push(
    `${them.name}: health ${them.healthPct}%, ${them.poisoned ? "POISONED" : "not poisoned"}, ` +
      (them.weapon ? `wields a ${them.weapon}, ` : "no weapon (a caster), ") +
      (them.casting ? `casting (lands in about ${seconds(them.landsInMs)}), ` : "not casting, ") +
      `${them.distance} tiles away, ${them.inLineOfSight ? "in line of sight" : "out of sight"}, ` +
      `${inReach(s) ? "within your reach" : "out of your reach"}.`,
  );
  if (s.recent.length) {
    lines.push(`Recent: ${s.recent.slice(-4).join("; ")}.`);
  }
  return lines.join("\n");
}

/** Every move this fighter has; consumables only when the template carries them. */
export function meleeOptions(s: DuelSnapshot): Record<string, string> {
  const w = s.us.weapon;
  const sup = s.supplies;
  const o: Record<string, string> = {};
  o["attack:swing"] = w?.ranged ? "attack: shoot them" : "attack: close in and hit them";
  if (w) {
    const special = (name: string, mana: number) =>
      `attack: ${camelToWords(name)}, ${ABILITIES[name as AbilityName]?.text ?? "a special move"} (${mana} mana)`;
    o["attack:primary"] = special(w.primary, w.primaryMana);
    o["attack:secondary"] = special(w.secondary, w.secondaryMana);
  }
  if (sup) {
    o["heal:bandage"] = "heal: bandage yourself (cures poison too; takes a few seconds, you keep fighting)";
    // Drinking needs a free hand: a bow, a halberd or a shield rules it out. Throwing does not
    // (ModernUO: an explosion potion's RequireFreeHand is false).
    if (s.us.freeHand !== false) {
      if (sup.healPotions > 0) {
        o["heal:potion"] = "heal: drink a Greater Heal potion (once every 10 s)";
      }
      if (sup.curePotions > 0) {
        o["cure:potion"] = "cure: drink a Greater Cure potion";
      }
      if (sup.refreshPotions > 0) {
        o["refresh:potion"] = "refresh: drink a Total Refresh potion (stamina)";
      }
    }
    if (sup.explosionPotions > 0) {
      o["throw:explosion"] = "throw: an Explosion potion at them (bursts after a moment)";
    }
  }
  o["move:retreat"] = "move: run out of their reach";
  return o;
}

/**
 * Only the moves the game would accept now, narrowed by a person's tactics (health bands on
 * bandages, heal potions and retreating): a model cannot pick what it is not offered.
 */
export function legalMeleeOptions(s: DuelSnapshot, t: Tactics = NEUTRAL): Record<string, string> {
  const all = meleeOptions(s);
  const legal = Object.keys(all).filter((key) => !blockedMelee(key, s, t));
  if (!legal.length) {
    return { "attack:swing": all["attack:swing"] };
  }
  const health = s.us.hitsMax > 0 ? (100 * s.us.hits) / s.us.hitsMax : 100;
  return Object.fromEntries(applyBands(legal, health, t).options.map((key) => [key, all[key]]));
}

export function meleeQuestion(s: DuelSnapshot, t: Tactics = NEUTRAL): Record<string, ChoiceQuestion> {
  return {
    move: { type: "choice", instructions: `What should ${s.us.name} do next?`, criteria: legalMeleeOptions(s, t) },
  };
}

/** Why an option cannot be used right now, or null if it can. */
export function blockedMelee(key: string, s: DuelSnapshot, t: Tactics = NEUTRAL): string | null {
  const { us, them } = s;
  const sup = s.supplies;
  if (key.startsWith("attack:")) {
    if (them.dead) {
      return `${them.name} is dead`;
    }
    if (key === "attack:swing") {
      return null;
    }
    const which = key === "attack:primary" ? "primary" : "secondary";
    const cost = abilityCost(s, which);
    return us.mana < cost ? `not enough mana (${cost})` : null;
  }
  switch (key) {
    case "heal:bandage":
      return !sup?.bandages
        ? "no bandages"
        : (us.bandagingForMs ?? 0) > 0
          ? "already bandaging"
          : us.hits >= us.hitsMax && !us.poisoned
            ? "not hurt"
            : null;
    case "heal:potion":
      // ModernUO refuses a heal potion to the poisoned and the mortally struck (BaseHealPotion).
      return !sup?.healPotions
        ? "no heal potions"
        : (us.healPotionReadyInMs ?? 0) > 0
          ? "heal potion not ready"
          : us.hits >= us.hitsMax
            ? "at full health"
            : us.poisoned
              ? "poisoned: a heal potion does nothing until cured"
              : us.mortalStrike
                ? "mortally struck: no healing until it wears off"
                : null;
    case "cure:potion":
      return !sup?.curePotions ? "no cure potions" : us.poisoned ? null : "not poisoned";
    case "refresh:potion":
      return !sup?.refreshPotions ? "no refresh potions" : us.stam >= us.stamMax * 0.9 ? "stamina is fine" : null;
    case "throw:explosion":
      return !sup?.explosionPotions
        ? "no explosion potions"
        : them.distance > t.explosionRange[1] || !them.inLineOfSight
          ? "out of throwing range"
          : them.distance < t.explosionRange[0]
            ? "too close: it would burst on you too"
            : null;
    case "move:retreat": {
      const hurt = us.hits < us.hitsMax * 0.8 || us.poisoned;
      return !hurt ? "healthy enough to stand and fight" : them.distance > 12 ? "already out of reach" : null;
    }
  }
  return `unknown option ${key}`;
}

const PLANS: Record<string, Plan> = {
  "attack:swing": { kind: "attack" },
  "attack:primary": { kind: "attack", ability: "primary" },
  "attack:secondary": { kind: "attack", ability: "secondary" },
  "heal:bandage": { kind: "bandage" },
  "heal:potion": { kind: "drink", potion: "heal" },
  "cure:potion": { kind: "drink", potion: "cure" },
  "refresh:potion": { kind: "drink", potion: "refresh" },
  "throw:explosion": { kind: "throw", potion: "explosion" },
  "move:retreat": { kind: "retreat" },
};

/** The most probable usable option as a plan; notes when that differs from the raw choice. */
export function resolveMeleePlan(
  s: DuelSnapshot,
  d: Distribution,
  overrides: string[],
  t: Tactics = NEUTRAL,
): { plan: Plan; why: string } {
  const options = meleeOptions(s);
  const ranked = Object.entries(d.probabilities)
    .filter(([k]) => k in options)
    .sort((a, b) => b[1] - a[1]);
  for (const [key] of ranked) {
    const reason = blockedMelee(key, s, t);
    if (!reason) {
      if (key !== d.choice) {
        overrides.push(`${d.choice} → ${key} (${blockedMelee(d.choice, s, t) ?? "not offered"})`);
      }
      return { plan: PLANS[key], why: options[key] };
    }
  }
  overrides.push("nothing usable; attacking");
  return { plan: { kind: "attack" }, why: options["attack:swing"] };
}

/**
 * The scripted fighter: cure when poisoned, drink a heal when low, bandage when hurt, refresh when
 * tired, throw an explosion from a few tiles, open with the secondary ability, otherwise hit.
 */
export function meleeBaseline(s: DuelSnapshot): string {
  const { us, them } = s;
  const hp = us.hitsMax > 0 ? us.hits / us.hitsMax : 1;
  const ok = (key: string) => key in meleeOptions(s) && !blockedMelee(key, s);
  if (us.poisoned && ok("cure:potion")) {
    return "cure:potion";
  }
  if (us.poisoned && ok("heal:bandage")) {
    return "heal:bandage"; // with Healing and Anatomy of 60+, a bandage cures poison
  }
  if (hp < 0.45 && ok("heal:potion")) {
    return "heal:potion";
  }
  if (hp < 0.8 && ok("heal:bandage")) {
    return "heal:bandage";
  }
  if (us.stam < us.stamMax * 0.3 && ok("refresh:potion")) {
    return "refresh:potion";
  }
  if (them.distance >= 3 && them.distance <= 6 && them.healthPct > 30 && ok("throw:explosion")) {
    return "throw:explosion";
  }
  if (them.distance <= reach(s) && ok("attack:secondary")) {
    return "attack:secondary";
  }
  return "attack:swing";
}

/** Mode = sum of its options; each mode's options renormalised. Works for any "mode:option" answer. */
export function splitByMode(d: Distribution): { mode: Distribution; parts: Record<string, Distribution> } {
  const byMode: Record<string, Record<string, number>> = {};
  for (const [key, p] of Object.entries(d.probabilities)) {
    const [mode, option] = key.split(":");
    byMode[mode] ??= {};
    byMode[mode][option ?? mode] = p;
  }
  const norm = (p: Record<string, number>): Distribution => {
    const total = Object.values(p).reduce((a, b) => a + b, 0) || 1;
    const probabilities = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v / total]));
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    return { choice, probabilities };
  };
  const totals = Object.fromEntries(Object.entries(byMode).map(([m, p]) => [m, Object.values(p).reduce((a, b) => a + b, 0)]));
  return { mode: norm(totals), parts: Object.fromEntries(Object.entries(byMode).map(([m, p]) => [m, norm(p)])) };
}
