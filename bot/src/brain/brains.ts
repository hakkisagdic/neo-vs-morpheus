// Duel brains: a System One model (Laya or Jev) and a scripted baseline.
import { spell } from "../uo/spells.ts";
import { compositeQuestion, describeDuel, duelQuestions, resolvePlan, splitComposite } from "./duel-policy.ts";
import { type Backend, systemOne } from "./systemone.ts";
import {
  DAMAGE_SPELLS,
  DEFENSE_SPELLS,
  type Decision,
  type Distribution,
  type DuelBrain,
  type DuelSnapshot,
  INTERRUPT_SPELLS,
  type Mode,
} from "./types.ts";

/**
 * "composite": one question with every mode:spell option (one forward pass).
 * "split": the Jev monitor's layout, one question per mode plus the teleport tile (five passes).
 */
export type QuestionStyle = "composite" | "split";

/** Asks a System One backend the duel questions, then applies the guardrails. */
export class ModelBrain implements DuelBrain {
  readonly name: string;
  readonly backend: Backend;
  readonly style: QuestionStyle;

  constructor(backend: Backend, style: QuestionStyle = "composite") {
    this.backend = backend;
    this.name = backend.name;
    this.style = style;
  }

  async decide(s: DuelSnapshot): Promise<Decision> {
    const composite = this.style === "composite";
    const d = await systemOne(this.backend, describeDuel(s), composite ? compositeQuestion(s) : duelQuestions(s));
    const a = d.answers;
    const parts = composite
      ? splitComposite(a.move)
      : { mode: a.nextAction, damage: a.damageSpell, interrupt: a.interruptSpell, defense: a.defenseSpell };
    const byMode: Record<Mode, Distribution> = {
      damage: parts.damage,
      interrupt: parts.interrupt,
      defense: parts.defense,
    };
    const overrides: string[] = [];
    const tileAnswer = composite ? undefined : a.teleportTile;
    const { plan, why } = resolvePlan(s, parts.mode, byMode, tileAnswer, overrides);
    const tile = tileAnswer ? s.tiles.find((t) => t.id === tileAnswer.choice) : undefined;
    return {
      brain: this.name,
      model: d.model,
      latencyMs: d.latencyMs,
      inputTokens: d.usage.inputTokens,
      outputTokens: d.usage.outputTokens,
      mode: parts.mode,
      damage: byMode.damage,
      interrupt: byMode.interrupt,
      defense: byMode.defense,
      tile: tile && tileAnswer ? { ...tileAnswer, x: tile.x, y: tile.y, label: tile.label } : undefined,
      plan,
      why,
      overrides,
    };
  }
}

const oneHot = (options: readonly string[], choice: string): Distribution => ({
  choice,
  probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 1 : 0])),
});

/**
 * The scripted baseline: a textbook duel mage. Deterministic, so a model's win rate against it
 * is a repeatable number.
 */
export class RuleBrain implements DuelBrain {
  readonly name = "rules";

  async decide(s: DuelSnapshot): Promise<Decision> {
    const started = performance.now();
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
    } else if (hp < 0.45 && can("greaterHeal")) {
      mode = "defense";
      defense = "greaterHeal";
    } else if (them.casting && them.landsInMs > 900 && spell(them.casting).circle >= 4 && can("magicArrow")) {
      mode = "interrupt";
      interrupt = them.distance <= 1 && can("harm") ? "harm" : "magicArrow";
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
      ...decision,
      plan,
      why,
      overrides,
    };
  }
}
