// Training Necromancy and Chivalry ("kasma") the way ./train-brain.ts trains Magery: the practice
// spells and their odds in ModernUO (ML rules), what a player is told about them, and the choices
// of the scripted trainer and of the oracle (expected gains a second, ./train-odds.ts).
//
// A necromancer's spell can gain from its required skill to 40 above it, a paladin's to 50 above
// (NecromancerSpell / PaladinSpell.GetCastSkills); Vampiric Embrace, once Necromancy reaches 99,
// from 80 to 120. A necromancer's fizzle spends the reagents but no mana, as a mage's does
// (Spell.CheckSequence). A paladin's spends the tithing points, which go before the roll, and no
// mana, and has no recovery: the next cast can start at once (PaladinSpell.CheckFizzle, DoFizzle).
// Reagents and tithing points cost no time while they last, and the trainees' templates carry
// enough for the longest session: the oracle weighs the time a cast takes and the mana it spends.
//
// Practice spells are the ones a trainee can cast alone and unharmed. The necromancer's forms are
// cast on oneself and toggle: a success takes the form, or ends it if already in it (another
// form gives way to it). In Lich Form mana comes back 13 points faster, but a hit point goes every
// 2.5 s, faster than they come back (0.3 a second; RegenRates, LichFormSpell.OnTick); in Horrific
// Beast only the forms can be cast. Wither hurts only others around. Not practised: Curse Weapon (a weapon in
// hand, and no challenge past 40), Animate Dead (a corpse), Summon Familiar (a gump), Exorcism
// (Spirit Speak 100 and a champion spawn), and the curses, which want someone else (Pain Spike,
// Poison Strike, Strangle, Mind Rot, Evil Omen, Corpse Skin, Vengeful Spirit; Blood Oath refuses
// the caster) and would hurt the trainee on itself. A paladin practises Divine Fury, Enemy of One
// and the area spells, Dispel Evil, Holy Light and Noble Sacrifice (no one around to hit or save);
// Consecrate Weapon wants a weapon in hand, Close Wounds a wound, Cleanse by Fire poison, Sacred
// Journey a rune, and Remove Curse, which works on oneself, is no challenge past 55.
import { type Spell, spell } from "../uo/spells.ts";
import { gainChance, manaPerSecond, tranceChance } from "./train-odds.ts";

export const NECRO_QUESTION = "Which move raises your Necromancy the fastest from here?";
/** The necromancer's training state and question as models read them; recorded with every session. */
export const NECRO_FORMAT = "necromancy-1";
export const CHIVALRY_QUESTION = "Which move raises your Chivalry the fastest from here?";
/** The paladin's. */
export const CHIVALRY_FORMAT = "chivalry-1";

/** The necromancer's practice spells, by the skill they start at. */
export const NECRO_PRACTICE: readonly string[] = ["wraithForm", "horrificBeast", "wither", "lichForm", "vampiricEmbrace"];
/** The paladin's. */
export const CHIVALRY_PRACTICE: readonly string[] = ["divineFury", "dispelEvil", "enemyOfOne", "holyLight", "nobleSacrifice"];

export type NecroForm = "wraithForm" | "horrificBeast" | "lichForm" | "vampiricEmbrace";
const FORMS: readonly string[] = ["wraithForm", "horrificBeast", "lichForm", "vampiricEmbrace"];
export const isForm = (key: string | null): key is NecroForm => key !== null && FORMS.includes(key);

/** The forms' bodies (male and female) as the server shows them: the trainee's form is its body. */
export const FORM_BODIES: Readonly<Record<number, NecroForm>> = {
  744: "vampiricEmbrace",
  745: "vampiricEmbrace",
  746: "horrificBeast",
  747: "wraithForm",
  748: "wraithForm",
  749: "lichForm",
};

/** Mana regeneration points a form adds (RegenRates.Mobile_ManaRegenRate). */
const FORM_MANA: Partial<Record<NecroForm, number>> = { lichForm: 13, vampiricEmbrace: 3 };

const FORM_TEXT: Record<NecroForm | "none", string> = {
  none: "You are in your own form.",
  wraithForm: "You are in Wraith Form.",
  horrificBeast: "You are in Horrific Beast form: only the forms can be cast in it.",
  lichForm: "You are in Lich Form.",
  vampiricEmbrace: "You are in Vampiric Embrace: mana comes back 0.3 a second faster.",
};

/** In Lich Form, at this share of the hits or less, only a way out of it (a form) or a rest is offered. */
const LICH_LAST = 0.25;
/** The scripted trainer and the oracle leave Lich Form below this share of the hits. */
const LICH_LEAVE = 0.5;

/**
 * Seconds from a paladin's fizzle to the next cast: a decision and a round trip (under 0.1 s
 * against a local server: the oracle's next step came within the same tenth of a second). A
 * success waits out the recovery instead.
 */
export const FIZZLE_STEP_S = 0.05;

/** A necromancer in training, as the trainer sees it. */
export type NecroState = {
  skill: "necromancy";
  necromancy: number;
  spiritSpeak: number;
  meditation: number;
  /** All the trainee's skills together: the more, the slower each rises. */
  allSkills: number;
  int: number;
  hits: number;
  hitsMax: number;
  mana: number;
  manaMax: number;
  /** The form the trainee is in, if any. */
  form: NecroForm | null;
  meditating: boolean;
  /** Seconds until the next skill can be used (after Meditation 10 s). */
  skillReadyIn: number;
  casts: number;
  fizzles: number;
  /** Necromancy gained since the session began, and the session's seconds so far. */
  gained: number;
  seconds: number;
};

/** A paladin in training. */
export type ChivalryState = {
  skill: "chivalry";
  chivalry: number;
  focus: number;
  meditation: number;
  allSkills: number;
  int: number;
  mana: number;
  manaMax: number;
  tithing: number;
  meditating: boolean;
  skillReadyIn: number;
  casts: number;
  fizzles: number;
  gained: number;
  seconds: number;
};

/** The range in which a cast can gain (and succeed now and then): [too difficult below, no challenge from]. */
export function castWindow(sp: Spell, skill: number): [number, number] {
  const min = sp.requiredSkill ?? 0;
  if (sp.school === "chivalry") {
    return [min, min + 50];
  }
  if (sp.key === "vampiricEmbrace" && skill >= min) {
    return [80, 120];
  }
  return [min, min + 40];
}

export function castChance(sp: Spell, skill: number): number {
  const [min, max] = castWindow(sp, skill);
  return Math.min(1, Math.max(0, (skill - min) / (max - min)));
}

/** Of the keys, the one whose chance is nearest a coin flip (the first of equals). */
function nearestEven(keys: readonly string[], chance: (key: string) => number): string | undefined {
  let best: string | undefined;
  for (const key of keys) {
    if (best === undefined || Math.abs(chance(key) - 0.5) < Math.abs(chance(best) - 0.5)) {
      best = key;
    }
  }
  return best;
}

type Resting = { mana: number; manaMax: number; meditation: number; meditating: boolean; skillReadyIn: number };

/** Meditation as Magery offers it, while mana is short of full. */
function meditateOption(s: Resting): Record<string, string> {
  if (s.mana >= s.manaMax) {
    return {};
  }
  const wait = s.skillReadyIn > 0 ? Math.ceil(s.skillReadyIn) : 0;
  return {
    meditate: s.meditating
      ? "Keep meditating"
      : wait
        ? `Rest until skills can be used (${wait} s), then meditate`
        : `Meditate: about ${Math.round(100 * tranceChance(s.meditation, s.manaMax - s.mana))}% to enter a trance`,
  };
}

/**
 * The scripted trainer's rest, as for Magery: meditate when mana is short of the spell, once a
 * trance is down to an even chance, and in a trance back to nearly full mana.
 */
function rulesRest(s: Resting, cost: number): boolean {
  const low = s.mana < cost + 5;
  const trance = !s.meditating && tranceChance(s.meditation, s.manaMax - s.mana) <= 0.5;
  return low || trance || (s.meditating && s.mana < s.manaMax * 0.9);
}

/**
 * The oracle's rest, as for Magery: while casting spends mana faster than it comes back, try a
 * trance once the odds come down to about even (below 30% a try mostly wastes its 10 s), and stay
 * in it to 90%; rest whenever the mana is short of the spell.
 */
function oracleRest(s: Resting, cost: number, draining: boolean): boolean {
  const trance = tranceChance(s.meditation, s.manaMax - s.mana);
  return s.mana < cost || (draining && (s.meditating ? s.mana < s.manaMax * 0.9 : trance >= 0.3 && trance <= 0.5));
}

const pct = (p: number) => `about ${Math.round(100 * p)}% to succeed`;
const secondsText = (sp: Spell) => `${sp.delayMs / 1000} s`;

// Necromancy.

const necroMana = (s: Pick<NecroState, "int" | "meditation">, form: NecroForm | null, trance: boolean) =>
  manaPerSecond(s.int, s.meditation, trance, 0, form ? (FORM_MANA[form] ?? 0) : 0);

/** Mana a second while practising a spell: a form practised toggles, half the time in it; anything else keeps the form. */
function practiceMana(s: NecroState, key: string, trance: boolean): number {
  return isForm(key) ? (necroMana(s, key, trance) + necroMana(s, null, trance)) / 2 : necroMana(s, s.form, trance);
}

/** Whether a practice spell may be cast now (mana aside): some chance, and a form that allows it. */
function necroAllowed(s: NecroState, key: string): boolean {
  if (castChance(spell(key), s.necromancy) <= 0) {
    return false;
  }
  // Horrific Beast lets only the forms be cast; near the end of the hits in Lich Form only a way
  // out is offered (another form ends it too).
  return isForm(key) || (s.form !== "horrificBeast" && !(s.form === "lichForm" && s.hits <= s.hitsMax * LICH_LAST));
}

const necroCastable = (s: NecroState, key: string) => necroAllowed(s, key) && s.mana >= spell(key).mana;

function formNote(s: NecroState, key: string): string {
  if (!isForm(key)) {
    return "";
  }
  return s.form === key ? "; a success ends the form" : `; a success takes the form${s.form ? ` instead of ${spell(s.form).name}` : ""}`;
}

/** The moves open to a necromancer, as option -> what a player would know about it. */
export function necroOptions(s: NecroState): Record<string, string> {
  const options: Record<string, string> = {};
  for (const key of NECRO_PRACTICE) {
    if (necroCastable(s, key)) {
      const sp = spell(key);
      options[`cast:${key}`] = `Cast ${sp.name} (${sp.mana} mana, ${secondsText(sp)}): ${pct(castChance(sp, s.necromancy))}${formNote(s, key)}`;
    }
  }
  return { ...options, ...meditateOption(s) };
}

export function describeNecro(s: NecroState): string {
  const wait = s.skillReadyIn > 0 ? Math.ceil(s.skillReadyIn) : 0;
  return [
    "Ultima Online skill training: raise Necromancy as fast as you can.",
    `Skills: Necromancy ${s.necromancy.toFixed(1)}, Spirit Speak ${s.spiritSpeak.toFixed(1)}, Meditation ${s.meditation.toFixed(1)}; all your skills together ${s.allSkills.toFixed(1)}.`,
    `Hits ${s.hits} of ${s.hitsMax}; mana ${s.mana} of ${s.manaMax}, ${s.meditating ? "in a meditative trance" : "not meditating"}. Mana comes back ${necroMana(s, s.form, false).toFixed(1)} a second, ${necroMana(s, s.form, true).toFixed(1)} in a trance; a cast or a skill use ends a trance.`,
    FORM_TEXT[s.form ?? "none"],
    "The forms (Wraith Form, Horrific Beast, Lich Form, Vampiric Embrace) are cast on yourself: a success takes the form, or ends it if you are in it already. In Lich Form mana comes back 1.3 a second faster, but you lose a hit point every 2.5 s and get only 0.3 back; in Horrific Beast only the forms can be cast. Wither hurts only others around you.",
    "A cast can raise Necromancy whether it succeeds or fizzles, as long as its chance is above 0% and below 100%; a fizzle uses reagents but no mana.",
    `Skills ${wait ? `can be used again in ${wait} s` : "can be used now"}: a try at Meditation keeps the next one waiting 10 s.`,
    `So far: ${s.casts} casts, ${s.fizzles} fizzled; Necromancy ${s.gained >= 0 ? "+" : ""}${s.gained.toFixed(1)} in ${Math.round(s.seconds / 60)} minutes.`,
  ].join("\n");
}

/** Out of Lich Form before the hits run low: its own cast, or a rest until it can be cast. */
const leaveLich = (s: NecroState): string | undefined =>
  s.form === "lichForm" && s.hits < s.hitsMax * LICH_LEAVE ? (necroCastable(s, "lichForm") ? "cast:lichForm" : "meditate") : undefined;

/** The scripted trainer: the spell nearest even odds, rested for as Magery's trainer rests. */
export function necroRules(s: NecroState): string {
  const out = leaveLich(s);
  if (out) {
    return out;
  }
  const key = nearestEven(
    NECRO_PRACTICE.filter((k) => necroAllowed(s, k)),
    (k) => castChance(spell(k), s.necromancy),
  );
  return !key || rulesRest(s, spell(key).mana) ? "meditate" : `cast:${key}`;
}

/**
 * Expected Necromancy gains a second from practising a spell, as Magery's castScore: the gain
 * chance over the cast's delay and recovery, scaled by the share of time left for casting while it
 * spends mana faster than the form lets it come back (the rest goes to meditation).
 */
export function necroScore(s: NecroState, key: string): number {
  if (!necroAllowed(s, key)) {
    return 0;
  }
  const sp = spell(key);
  const p = castChance(sp, s.necromancy);
  const seconds = (sp.delayMs + sp.recoveryMs) / 1000;
  const drain = (p * sp.mana) / seconds - practiceMana(s, key, false);
  const trance = practiceMana(s, key, true);
  return (gainChance(s.allSkills, s.necromancy, p) / seconds) * (drain > 0 ? trance / (drain + trance) : 1);
}

/** The oracle: the spell with the most expected gains a second, rested for while it drains mana. */
export function necroOracle(s: NecroState): string {
  const out = leaveLich(s);
  if (out) {
    return out;
  }
  const allowed = NECRO_PRACTICE.filter((k) => necroAllowed(s, k));
  let key = nearestEven(allowed, (k) => castChance(spell(k), s.necromancy));
  let best = 0;
  for (const k of allowed) {
    const score = necroScore(s, k);
    if (score > best) {
      key = k;
      best = score;
    }
  }
  if (!key) {
    return "meditate";
  }
  const sp = spell(key);
  const seconds = (sp.delayMs + sp.recoveryMs) / 1000;
  const draining = (castChance(sp, s.necromancy) * sp.mana) / seconds > practiceMana(s, key, false);
  return oracleRest(s, sp.mana, draining) ? "meditate" : `cast:${key}`;
}

// Chivalry.

const chivalryMana = (s: Pick<ChivalryState, "int" | "meditation" | "focus">, trance: boolean) => manaPerSecond(s.int, s.meditation, trance, s.focus);

/** Seconds a paladin's cast takes on average: its delay, then the recovery after a success or a step after a fizzle. */
export const chivalrySeconds = (sp: Spell, p: number) => sp.delayMs / 1000 + p * (sp.recoveryMs / 1000) + (1 - p) * FIZZLE_STEP_S;

const chivalryAllowed = (s: ChivalryState, key: string) => castChance(spell(key), s.chivalry) > 0 && s.tithing >= (spell(key).tithing ?? 0);
const chivalryCastable = (s: ChivalryState, key: string) => chivalryAllowed(s, key) && s.mana >= spell(key).mana;

/** The moves open to a paladin, as option -> what a player would know about it. */
export function chivalryOptions(s: ChivalryState): Record<string, string> {
  const options: Record<string, string> = {};
  for (const key of CHIVALRY_PRACTICE) {
    if (chivalryCastable(s, key)) {
      const sp = spell(key);
      options[`cast:${key}`] = `Cast ${sp.name} (${sp.mana} mana, ${sp.tithing} tithing points, ${secondsText(sp)}): ${pct(castChance(sp, s.chivalry))}`;
    }
  }
  return { ...options, ...meditateOption(s) };
}

export function describeChivalry(s: ChivalryState): string {
  const wait = s.skillReadyIn > 0 ? Math.ceil(s.skillReadyIn) : 0;
  return [
    "Ultima Online skill training: raise Chivalry as fast as you can.",
    `Skills: Chivalry ${s.chivalry.toFixed(1)}, Focus ${s.focus.toFixed(1)}, Meditation ${s.meditation.toFixed(1)}; all your skills together ${s.allSkills.toFixed(1)}.`,
    `Mana ${s.mana} of ${s.manaMax}, ${s.meditating ? "in a meditative trance" : "not meditating"}; ${s.tithing} tithing points. Mana comes back ${chivalryMana(s, false).toFixed(1)} a second, ${chivalryMana(s, true).toFixed(1)} in a trance; a cast or a skill use ends a trance.`,
    "A cast can raise Chivalry whether it succeeds or fizzles, as long as its chance is above 0% and below 100%. Every cast spends its tithing points; only a success spends mana and is followed by 1.75 s of recovery: after a fizzle the next cast can start at once.",
    `Skills ${wait ? `can be used again in ${wait} s` : "can be used now"}: a try at Meditation keeps the next one waiting 10 s.`,
    `So far: ${s.casts} casts, ${s.fizzles} fizzled; Chivalry ${s.gained >= 0 ? "+" : ""}${s.gained.toFixed(1)} in ${Math.round(s.seconds / 60)} minutes.`,
  ].join("\n");
}

/** The scripted trainer: the spell nearest even odds, rested for as Magery's trainer rests. */
export function chivalryRules(s: ChivalryState): string {
  const key = nearestEven(
    CHIVALRY_PRACTICE.filter((k) => chivalryAllowed(s, k)),
    (k) => castChance(spell(k), s.chivalry),
  );
  return !key || rulesRest(s, spell(key).mana) ? "meditate" : `cast:${key}`;
}

/**
 * Expected Chivalry gains a second from practising a spell: the gain chance over the cast's
 * average time (a fizzle costs no recovery, so the hardest quick spells pay), scaled as for the
 * others by the share of time left for casting while it spends mana faster than it comes back.
 */
export function chivalryScore(s: ChivalryState, key: string): number {
  if (!chivalryAllowed(s, key)) {
    return 0;
  }
  const sp = spell(key);
  const p = castChance(sp, s.chivalry);
  const seconds = chivalrySeconds(sp, p);
  const drain = (p * sp.mana) / seconds - chivalryMana(s, false);
  const trance = chivalryMana(s, true);
  return (gainChance(s.allSkills, s.chivalry, p) / seconds) * (drain > 0 ? trance / (drain + trance) : 1);
}

/** The oracle: the spell with the most expected gains a second, rested for while it drains mana. */
export function chivalryOracle(s: ChivalryState): string {
  const allowed = CHIVALRY_PRACTICE.filter((k) => chivalryAllowed(s, k));
  let key = nearestEven(allowed, (k) => castChance(spell(k), s.chivalry));
  let best = 0;
  for (const k of allowed) {
    const score = chivalryScore(s, k);
    if (score > best) {
      key = k;
      best = score;
    }
  }
  if (!key) {
    return "meditate";
  }
  const sp = spell(key);
  const p = castChance(sp, s.chivalry);
  const draining = (p * sp.mana) / chivalrySeconds(sp, p) > chivalryMana(s, false);
  return oracleRest(s, sp.mana, draining) ? "meditate" : `cast:${key}`;
}
