// ModernUO's odds for skill training (ML rules), shared by every school: meditation's trance,
// mana regeneration, and the chance that a skill check gains.
//
// Meditation puts you in a trance with chance (50 + 2 × (skill − mana missing)) %, and every try
// keeps the next skill waiting 10 s; in a trance mana comes back faster, and a cast ends it.
// Mana regenerates 0.1 × (2 + points) a second, the points floored: (Int + 3 × Meditation) / 40
// (/ 36.4 at Meditation 100), as much again in a trance (13 at most), Focus / 20, and what a form
// adds (Lich Form 13, Vampiric Embrace 3; RegenRates.Mobile_ManaRegenRate).
// A skill check between the skill's limits gains with chance (g + (1 - p) / 2) / 2 when it
// succeeds and g / 2 when it fails, g = ((700 - all skills) / 700 + (100 - skill) / 100) / 2 and
// p its chance to succeed: g/2 + p(1 - p)/4 on average (SkillCheck.CheckSkill, AOS).

/** The chance that Meditation puts you in a trance now. */
export const tranceChance = (meditation: number, missing: number) => Math.min(1, Math.max(0, (50 + (meditation - missing) * 2) / 100));

/**
 * Mana a second (ModernUO, ML rules) from Int, Meditation and Focus, and a form's `bonus` points:
 * no armour or items.
 */
export function manaPerSecond(int: number, meditation: number, trance: boolean, focus = 0, bonus = 0): number {
  const med = (int + meditation * 3) * (meditation < 100 ? 0.025 : 0.0275);
  return 0.1 * (2 + Math.floor(focus * 0.05 + med + (trance ? Math.min(med, 13) : 0) + bonus));
}

/** The gain chance's part that does not depend on success: g/2 above. */
export const gainBase = (allSkills: number, skill: number) => ((700 - allSkills) / 700 + (100 - skill) / 100) / 4;

/** The chance that a check between the limits gains, on average over success and failure. */
export const gainChance = (allSkills: number, skill: number, p: number) => (p <= 0 || p >= 1 ? 0 : gainBase(allSkills, skill) + (p * (1 - p)) / 4);
