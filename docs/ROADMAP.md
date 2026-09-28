# Roadmap: from a mage duel to a complete UO bot

Status: proposal (2026-09-28). The duel bot works: a headless client, typed decisions from Jev or
Laya, guardrails, a live monitor and a distillation pipeline. This plan grows it into a bot that
plays every PvP template and the rest of the game (movement, PvM, travel, skills, trade), with
data and models published on Hugging Face.

## Principles

- **Models decide what, code decides how.** A model answers typed questions where judgement
  matters: fight or flee, which spell or weapon move, which target, where to stand. Deterministic
  executors do the rest: pathfinding, targeting, gumps, crafting menus, banking. Asking a model
  what a script can compute is slower, costlier and less reliable.
- **Legal options only.** Every question lists only moves the game accepts now; guardrails catch
  the rest, and every correction is logged.
- **Jev teaches, Laya plays.** Jev answers cost credits (about 0.92 per decision, so a live Jev
  bot burns about 1,100 an hour). Jev validates question designs on scenario suites, labels
  curated states and plays short live checks. Laya drives, is distilled from Jev per module, then
  trained on game outcomes (our server makes rollouts free), which is how it can pass its teacher.
- **Clean, fair, measured.** Each round starts in a verified empty arena (a leftover NPC once
  fought in every duel for two days), sides alternate, seeds are recorded, test sets are fixed
  before training, and results carry confidence intervals.
- **Everything versioned.** Code commit, state-description version, question version, teacher
  model and date travel with every label, run and checkpoint.

## Architecture

```
profile (era + shard) ─┐
template (build) ──────┼─► controller ─► module ─► question ─► brain (rules | jev | laya)
world state ───────────┘        │           │                     │
                                │           └─ guardrails ◄───────┘
                                └─► executors (move, cast, melee, bandage, potion, gump, ...)
every step ─► episode log (state, options, distribution, choice, plan, outcome) ─► datasets
```

- **Profiles** (`profiles/*.json`). An era profile fixes the rules: expansion (ModernUO ids: T2A 1,
  UOR 2, AOS 5, SE 6, ML 7), available skills and spells, cast and recovery times, bandage and
  potion timers. The local server is started with the same era. A shard profile adds the
  emulator (ModernUO, ServUO, RunUO, Sphere), address, client version, encryption and the shard's
  rules. Turkish shards differ (World of UO runs Age of Shadows, Pyramid runs SphereServer), so
  AOS is the first target profile and a pre-AOS/Sphere profile follows.
- **Templates** (`templates/*.json`). A build is data: stats, skills, equipment, consumables,
  spellbook, and the modules it uses. `[NeoTemplate` applies a template file on the server.
  Adding a template the user asks for is a JSON file plus, if it brings a new kind of action, a
  module.
- **Modules** (`bot/src/modules/*`). One capability each, behind one interface:

  ```ts
  interface Module {
    id: string;                                   // "mage-combat", "movement", "healing", ...
    applies(s: Situation): boolean;               // when it is in charge
    describe(s: Situation): string;               // versioned state text for the model
    question(s: Situation): ChoiceQuestion;       // legal options only
    execute(choice: string, s: Situation, x: Executors): Promise<Outcome>;
    baseline(s: Situation): string;               // rule policy: sparring partner and fallback
    scenarios: Scenario[];                        // canonical moments with accepted answers
  }
  ```

- **Controller.** In combat, one composite question per decision (latency matters: the
  mage module already asks one 16-option question instead of five). Outside combat, a
  hierarchical intent question (fight, chase, flee, recover, loot, travel, train, trade) picks the
  module.
- **Movement.** A* over walkable tiles (arena layout now, real map later), with chase (predict
  the target), flee (away from threat, towards cover or a gate), kite (hold a range) and
  line-of-sight breaking. The model picks the tactic and the target tile; the executor walks.
- **Arena.** Layouts with pillars and walls (`[NeoArena layout`), varied start distances,
  2v2 placements, and a clean-arena check before every round.

## Data

- One episode log format for everything (schema-versioned): episode and step ids, profile,
  template, module, state text and its description version, options, policy and version,
  distribution, choice, executed plan, overrides, outcome and reward parts.
- Two dataset kinds: **teacher-labelled states** per module (Jev distributions, for distillation)
  and **trajectories with outcomes** (for outcome-based training and analysis).
- Splits by match, never by step; fixed held-out test sets chosen by hash; deduplicated by state
  text; provenance on every row.
- Hugging Face: private dataset and model repos first, public after review. Parquet files, a
  dataset card (schema, provenance, splits, licence, known biases) and a model card (training
  data, evaluation, limits). Before publishing anything Jev produced, check the FreeJev and
  TypeSafe terms on training with and redistributing outputs; this also covers the labels
  already on the neo-duel-v1 release.

## Evaluation

- Per module: a scenario suite (like the twelve duel moments) scored for every brain.
- Live: round-robin tournaments between rules, Jev and each Laya version, per template matchup,
  sides alternated, Bradley-Terry ratings with confidence intervals, Jev rounds budgeted.
- Regression: executor and guardrail unit tests in CI; a fixed smoke tournament before releases.

## Milestones

| | scope | done when |
|---|---|---|
| M0 | Mage duel v2: 5,000 more Jev labels, whole-encoder fine-tune, clean re-runs of every live result (no NPC, sides alternated), README fixed | v2 measured against Jev and v1 on the fixed test set and in live rounds |
| M1 | Framework: profiles, templates, module interface, controller, episode log v2, arena layouts; mage ported; movement module (chase, flee, kite, line of sight) with a rule baseline and scenario suite | mage + movement beats the current bot; Jev validated on the new suites |
| M2 | Dexer and archer: melee and archery executors, special moves, bandages, potions; 1v1 matrix mage/dexer/archer | each module's suite and baseline in place, Jev live checks |
| M3 | Tamer, necro, paladin; 2v2 and target selection | as M2, plus 2v2 tournaments |
| M4 | Real world (needs the EA client files): map pathfinding, PvM and looting, travel, bank and vendors, skill training for every skill, gathering and crafting; AOS and pre-AOS/Sphere profiles; shard adapters | a character goes from new to a trained template on the local shard |
| M5 | Laya per module (one multi-task checkpoint), then outcome-based training; Hugging Face releases | Laya matches or beats Jev per module, datasets and models published |

## Playing on other shards

Only on shards that allow bots, or with the administrators' written permission; most shards ban
unattended play and third-party clients, and bot PvP against people who did not agree to it is
not acceptable. A shard profile must record that permission before the client connects to it.
Until then, a shard's era and rules are reproduced on the local server.

## Open questions

- Which Turkish shards, and do we have the administrators' permission?
- Hugging Face account or organisation for the repos.
- Jev credits after M0: about 4,000 remain, enough for roughly 4,000 labels across modules.
