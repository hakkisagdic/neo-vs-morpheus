// What a duel brain sees and what it decides.

export type Mode = "damage" | "interrupt" | "defense";

/** The spells each mode may pick, as in the Jev duel monitor this project reproduces. */
export const DAMAGE_SPELLS = [
  "poison",
  "explosion",
  "lightning",
  "teleport",
  "harm",
  "flamestrike",
  "magicArrow",
  "curse",
  "paralyze",
] as const;
export const INTERRUPT_SPELLS = ["harm", "weaken", "magicArrow"] as const;
/** Defensive moves: heals, cure, and running out of the opponent's range. */
export const DEFENSE_SPELLS = ["heal", "greaterHeal", "cure", "retreat"] as const;

export type Tile = { id: string; x: number; y: number; z: number; label: string };

export type DuelSnapshot = {
  now: number;
  us: {
    name: string;
    serial: number;
    hits: number;
    hitsMax: number;
    mana: number;
    manaMax: number;
    stam: number;
    stamMax: number;
    poisoned: boolean;
    x: number;
    y: number;
    z: number;
    /** ms until the server accepts our next cast (0 = now) */
    readyInMs: number;
    lastSpell: string | null;
    lastSpellAgoMs: number;
    /** The weapon in hand, if any (fighters). */
    weapon?: WeaponView | null;
    /** ms left on a bandage being applied (0 = none). */
    bandagingForMs?: number;
    /** ms until another heal potion can be drunk (0 = now). */
    healPotionReadyInMs?: number;
    /** ms since the last weapon ability; within 3 s another costs double. */
    lastAbilityAgoMs?: number;
    /** A hand free for potions (no two-handed weapon, no shield). */
    freeHand?: boolean;
  };
  them: {
    name: string;
    serial: number;
    /** 0..100 */
    healthPct: number;
    poisoned: boolean;
    x: number;
    y: number;
    z: number;
    dead: boolean;
    casting: string | null;
    castingForMs: number;
    /** estimated ms until their spell's cast delay ends */
    landsInMs: number;
    distance: number;
    inLineOfSight: boolean;
    inRange: boolean;
    /** What they wield: a weapon name, or null for bare hands (casters). */
    weapon?: string | null;
  };
  /** Consumables in the pack, for templates that carry them. */
  supplies?: Supplies;
  reagents: Record<string, number>;
  tiles: Tile[];
  recent: string[];
};

export type Distribution = { choice: string; probabilities: Record<string, number> };

export type WeaponView = {
  name: string;
  ranged: boolean;
  range: number;
  primary: string;
  primaryMana: number;
  secondary: string;
  secondaryMana: number;
};

export type Supplies = {
  bandages: number;
  healPotions: number;
  curePotions: number;
  refreshPotions: number;
  explosionPotions: number;
  arrows: number;
};

/** Which decision module a fighter uses: spells, or weapons and consumables. */
export type ModuleName = "mage" | "melee";

export type Plan =
  | { kind: "cast"; spell: string; target: "them" | "self" }
  | { kind: "teleport"; tile: Tile }
  | { kind: "approach" }
  | { kind: "retreat" }
  | { kind: "attack"; ability?: "primary" | "secondary" }
  | { kind: "bandage" }
  | { kind: "drink"; potion: "heal" | "cure" | "refresh" }
  | { kind: "throw"; potion: "explosion" }
  | { kind: "wait"; ms: number };

export type Decision = {
  brain: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  module: ModuleName;
  /** The intent: the composite answer summed by mode. */
  mode: Distribution;
  /** Each mode's options, renormalised (mage: damage, interrupt, defense). */
  parts: Record<string, Distribution>;
  tile?: Distribution & { x: number; y: number; label: string };
  plan: Plan;
  /** Short reason shown on the monitor. */
  why: string;
  /** Guardrail corrections applied to the model's raw choice. */
  overrides: string[];
};

export interface DuelBrain {
  readonly name: string;
  decide(snapshot: DuelSnapshot): Promise<Decision>;
}
