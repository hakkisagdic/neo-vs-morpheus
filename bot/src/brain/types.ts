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
export const DEFENSE_SPELLS = ["heal", "greaterHeal", "cure"] as const;

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
  };
  reagents: Record<string, number>;
  tiles: Tile[];
  recent: string[];
};

export type Distribution = { choice: string; probabilities: Record<string, number> };

export type Plan =
  | { kind: "cast"; spell: string; target: "them" | "self" }
  | { kind: "teleport"; tile: Tile }
  | { kind: "approach" }
  | { kind: "wait"; ms: number };

export type Decision = {
  brain: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  mode: Distribution;
  damage: Distribution;
  interrupt: Distribution;
  defense: Distribution;
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
