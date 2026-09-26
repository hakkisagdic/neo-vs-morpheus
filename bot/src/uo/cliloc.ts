// Localized message numbers the bot reacts to. The text is here only for logs: without the
// client's cliloc files the server sends numbers, not sentences.

export const CLILOC = {
  spellFizzles: 502632, // The spell fizzles.
  concentrationDisturbed: 500641, // Your concentration is disturbed, thus ruining thy spell.
  alreadyCasting: 502642, // You are already casting a spell.
  notRecovered: 502644, // You have not yet recovered from casting a spell.
  insufficientMana: 502625, // Insufficient mana for this spell.
  insufficientManaNew: 1060174, // You must have at least ~1_MANA_REQUIREMENT~ Mana to use this ability.
  moreReagents: 502630, // More reagents are needed for this spell.
  targetNotSeen: 500237, // Target can not be seen.
  tooFar: 500446, // That is too far away.
  cannotTeleport: 501942, // That location is blocked.
  youAreFrozen: 500111, // You are frozen and can not move.
  targetFrozen: 1005603, // The target is already frozen.
} as const;

const NAMES = new Map<number, string>(Object.entries(CLILOC).map(([name, number]) => [number, name]));

export const clilocName = (number: number): string => NAMES.get(number) ?? `cliloc ${number}`;
