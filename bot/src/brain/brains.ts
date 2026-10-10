// Duel brains: a System One model (Laya or Jev) and a scripted baseline.
import { spell } from "../uo/spells.ts";
import { compositeQuestion, describeDuel, duelQuestions, resolvePlan, splitComposite, tacticalOptions } from "./duel-policy.ts";
import { describeMelee, meleeBaseline, meleeOptions, meleeQuestion, resolveMeleePlan, splitByMode } from "./melee-policy.ts";
import { type Backend, type Decision as SystemOneDecision, systemOne } from "./systemone.ts";
import { NEUTRAL, type Tactics, shapeAnswer } from "./tactics.ts";
import {
  DAMAGE_SPELLS,
  DEFENSE_SPELLS,
  type Decision,
  type Distribution,
  type DuelBrain,
  type DuelSnapshot,
  INTERRUPT_SPELLS,
  type Mode,
  type ModuleName,
} from "./types.ts";

/**
 * "composite": one question with every mode:spell option (one forward pass).
 * "split": the Jev monitor's layout, one question per mode plus the teleport tile (five passes).
 */
export type QuestionStyle = "composite" | "split";

/** What a paced player is told: it acts once every decisionMs, on the state that much older. */
export const paceLine = (decisionMs: number) =>
  `Pace: you decide once every ${decisionMs / 1000} s, and each move is carried out ${decisionMs / 1000} s after the state it answers.`;

/** Asks a System One backend the duel questions, then applies the guardrails. */
export class ModelBrain implements DuelBrain {
  readonly name: string;
  readonly backend: Backend;
  readonly style: QuestionStyle;
  readonly module: ModuleName;
  /**
   * A decision time to act on, as the scripted bot's reaction time: a quicker answer waits it out,
   * so that models of very different speeds (Jev's 3 s, Laya's 40 ms) can be compared at one pace.
   */
  readonly decisionMs?: number;
  /** Tell the model its decision time in the state it reads (UO Bench's paced tracks). */
  readonly tellPace: boolean;

  constructor(backend: Backend, style: QuestionStyle = "composite", module: ModuleName = "mage", decisionMs?: number, tellPace = false) {
    this.backend = backend;
    this.name = backend.name;
    this.style = style;
    this.module = module;
    this.decisionMs = decisionMs;
    this.tellPace = tellPace;
  }

  /** The state text, with the pace when the model is to be told it. */
  #describe(text: string): string {
    return this.tellPace && this.decisionMs !== undefined ? `${text}\n${paceLine(this.decisionMs)}` : text;
  }

  async decide(s: DuelSnapshot, tactics: Tactics = NEUTRAL): Promise<Decision> {
    const started = performance.now();
    const decision = await this.#decideNow(s, tactics);
    if (this.decisionMs === undefined) {
      return decision;
    }
    for (let wait = this.decisionMs - (performance.now() - started); wait > 0; wait = this.decisionMs - (performance.now() - started)) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, wait)));
    }
    return { ...decision, latencyMs: performance.now() - started };
  }

  async #decideNow(s: DuelSnapshot, tactics: Tactics): Promise<Decision> {
    if (this.module === "melee") {
      const d = await systemOne(this.backend, this.#describe(describeMelee(s)), meleeQuestion(s, tactics));
      const answer = shapeAnswer(d.answers.move, tactics.aggression);
      const { mode, parts } = splitByMode(answer);
      const overrides: string[] = [];
      const explored = exploration(answer, tactics.explore, this.random);
      if (explored) {
        overrides.push(`explore: ${explored} instead of ${answer.choice}`);
      }
      const { plan, why } = resolveMeleePlan(s, explored ? oneHot(Object.keys(answer.probabilities), explored) : answer, overrides, tactics);
      return {
        brain: this.name,
        model: d.model,
        latencyMs: d.latencyMs,
        inputTokens: d.usage.inputTokens,
        outputTokens: d.usage.outputTokens,
        module: "melee",
        mode,
        parts,
        plan,
        why,
        overrides,
        tactics,
        explored,
      };
    }
    const composite = this.style === "composite";
    const questions = composite ? compositeQuestion(s, tactics) : duelQuestions(s);
    const options = composite ? Object.keys(questions.move.criteria) : [];
    // One legal move or none (out of mana at full health): nothing to ask the model.
    const d =
      composite && options.length <= 1
        ? forced(options[0])
        : await systemOne(this.backend, this.#describe(describeDuel(s)), questions);
    const a = d.answers;
    const shaped = composite ? shapeAnswer(a.move, tactics.aggression) : null;
    const parts = shaped
      ? splitComposite(shaped)
      : { mode: a.nextAction, damage: a.damageSpell, interrupt: a.interruptSpell, defense: a.defenseSpell };
    const byMode: Record<Mode, Distribution> = {
      damage: parts.damage,
      interrupt: parts.interrupt,
      defense: parts.defense,
    };
    const overrides: string[] = composite ? tacticalOptions(s, tactics).notes.map((n) => `tactics: ${n}`) : [];
    const tileAnswer = composite ? undefined : a.teleportTile;
    // Exploring: the plan follows the option tried; the record keeps the model's own answer.
    const explored = shaped ? exploration(shaped, tactics.explore, this.random) : undefined;
    let chosen = byMode;
    let chosenMode = parts.mode;
    if (shaped && explored) {
      overrides.push(`explore: ${explored} instead of ${shaped.choice}`);
      const forcedParts = splitComposite(oneHot(Object.keys(shaped.probabilities), explored));
      chosen = { damage: forcedParts.damage, interrupt: forcedParts.interrupt, defense: forcedParts.defense };
      chosenMode = forcedParts.mode;
    }
    const { plan, why } = resolvePlan(s, chosenMode, chosen, tileAnswer, overrides, tactics);
    const tile = tileAnswer ? s.tiles.find((t) => t.id === tileAnswer.choice) : undefined;
    return {
      brain: this.name,
      model: d.model,
      latencyMs: d.latencyMs,
      inputTokens: d.usage.inputTokens,
      outputTokens: d.usage.outputTokens,
      module: "mage",
      mode: parts.mode,
      parts: byMode,
      tile: tile && tileAnswer ? { ...tileAnswer, x: tile.x, y: tile.y, label: tile.label } : undefined,
      plan,
      why,
      overrides,
      tactics,
      explored,
    };
  }

  /** The source of chance for exploration; tests replace it. */
  random: () => number = Math.random;
}

/**
 * With probability `share`, a legal option other than the answer's choice, picked uniformly: moves
 * the model never picks get tried in the states it meets, so their outcomes can be learnt.
 */
export function exploration(answer: Distribution, share: number, random: () => number = Math.random): string | undefined {
  const others = Object.keys(answer.probabilities).filter((k) => k !== answer.choice);
  if (share <= 0 || others.length === 0 || random() >= share) {
    return undefined;
  }
  return others[Math.min(others.length - 1, Math.floor(random() * others.length))];
}

/** The answer when the question has a single legal option, or none. */
const forced = (option: string | undefined): SystemOneDecision => ({
  model: "forced",
  answers: { move: { choice: option ?? "", probabilities: option ? { [option]: 1 } : {}, confidence: 1 } },
  usage: { inputTokens: 0, outputTokens: 0 },
  latencyMs: 0,
});

const oneHot = (options: readonly string[], choice: string): Distribution => ({
  choice,
  probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 1 : 0])),
});

/**
 * The scripted baseline: a textbook duel mage. Deterministic, so a model's win rate against it
 * is a repeatable number; for the same reason it ignores tactics.
 */
export class RuleBrain implements DuelBrain {
  readonly name = "rules";
  readonly module: ModuleName;
  /**
   * Time it takes to act on a decision. At 0 the bot answers in well under a millisecond, which a
   * person (about 0.2-0.3 s) or a model (0.25 s) never does, and a match then measures speed more
   * than judgement; a small delay keeps it fair and still hard to beat.
   */
  readonly reactionMs: number;

  constructor(module: ModuleName = "mage", reactionMs = 0) {
    this.module = module;
    this.reactionMs = reactionMs;
  }

  async decide(s: DuelSnapshot): Promise<Decision> {
    const started = performance.now();
    const decision = await this.#decideNow(s);
    // A timer can fire a millisecond early by performance.now(): wait out whatever is left.
    for (let wait = this.reactionMs - (performance.now() - started); wait > 0; wait = this.reactionMs - (performance.now() - started)) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, wait)));
    }
    return { ...decision, latencyMs: performance.now() - started };
  }

  async #decideNow(s: DuelSnapshot): Promise<Decision> {
    const started = performance.now();
    if (this.module === "melee") {
      const answer = oneHot(Object.keys(meleeOptions(s)), meleeBaseline(s));
      const { mode, parts } = splitByMode(answer);
      const overrides: string[] = [];
      const { plan, why } = resolveMeleePlan(s, answer, overrides);
      return {
        brain: this.name,
        model: "rules",
        latencyMs: performance.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        module: "melee",
        mode,
        parts,
        plan,
        why,
        overrides,
      };
    }
    const { us, them } = s;
    const hp = us.hitsMax > 0 ? us.hits / us.hitsMax : 1;
    const can = (key: string) => us.mana >= spell(key).mana;

    let mode: Mode = "damage";
    let defense = "greaterHeal";
    let interrupt = "magicArrow";
    let damage = "explosion";

    if (us.poisoned && hp < 0.85 && can("cure")) {
      mode = "defense";
      defense = "cure";
    } else if (hp < 0.3 && !can("greaterHeal")) {
      mode = "defense";
      defense = "retreat";
    } else if (hp < 0.45 && can("greaterHeal")) {
      mode = "defense";
      defense = "greaterHeal";
    } else if (them.casting && them.landsInMs > 900 && spell(them.casting).circle >= 4 && can("magicArrow")) {
      mode = "interrupt";
      // Weaken hits as it lands; a Magic Arrow flies 1.25 s more (AOS rules) and comes too late.
      interrupt = them.distance <= 1 && can("harm") ? "harm" : can("weaken") ? "weaken" : "magicArrow";
    } else if (!them.poisoned && can("poison")) {
      damage = "poison";
    } else if (can("explosion") && them.healthPct > 25) {
      damage = "explosion";
    } else if (can("lightning")) {
      damage = "lightning";
    } else if (can("harm")) {
      damage = "harm";
    } else {
      damage = "magicArrow";
    }

    const decision = {
      mode: oneHot(["damage", "interrupt", "defense"], mode),
      damage: oneHot(DAMAGE_SPELLS, damage),
      interrupt: oneHot(INTERRUPT_SPELLS, interrupt),
      defense: oneHot(DEFENSE_SPELLS, defense),
    };
    const overrides: string[] = [];
    const { plan, why } = resolvePlan(
      s,
      decision.mode,
      { damage: decision.damage, interrupt: decision.interrupt, defense: decision.defense },
      undefined,
      overrides,
    );
    return {
      brain: this.name,
      model: "rules",
      latencyMs: performance.now() - started,
      inputTokens: 0,
      outputTokens: 0,
      module: "mage",
      mode: decision.mode,
      parts: { damage: decision.damage, interrupt: decision.interrupt, defense: decision.defense },
      plan,
      why,
      overrides,
    };
  }
}
