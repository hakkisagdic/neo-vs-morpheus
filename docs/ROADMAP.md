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
- **Three kinds of change, three places.** Game and shard facts (versions, cast times, ranges,
  scripts) live in profiles that the state text and the legal options are built from; a person's
  preferences live in tactics; only the judgement between legal options is learnt. A shard that
  changes a cast time changes a profile, not the model.

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
- **Tactics** (`tactics/*.json`, `Name:brain:template:tactics`). A person's settings on top of the
  model, also adjustable live in the monitor: health bands on heals, retreats, bandages and heal
  potions (under the floor the move is required, above the ceiling it is not offered, in between
  the model decides), aggression (shifts the answer between attacking and moves on yourself),
  chase limits (tiles, seconds, teleport) and the explosion-potion range. Every decision records
  the values it was made with. Next, the model learns styles too: Jev labels the same states as
  cautious, balanced and aggressive, and the state text says which.
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

## Learning from play

Every game the bot or the user plays becomes training data, and mistakes weigh the most. The
source is the packet stream, not screenshots: the headless client already sees every packet, the
protocol is known, and reading the screen would be slower and less exact.

- **Flight recorder (the bot).** Every session, not only duels, writes the episode log: snapshot,
  state text with its versions, options, the brain's distribution and choice, guardrail
  overrides, the executed plan, and what followed (damage dealt and taken, fizzles and
  disturbs, refusals such as "You must wait", deaths and kills).
- **Demonstrations (the user).** The user plays with ClassicUO through a local recording proxy
  (client, proxy, server) that logs both directions without changing them. The proxy rewrites
  the relay packet (0x8C) so the client reconnects through it, and decodes the server's
  compression with our Huffman decoder. The same parser rebuilds the bot's snapshots, and the
  user's action (a cast, a target, a bandage, a step) is the chosen option: expert labels at no
  cost.
- **Mistake mining.** After each episode, rules find bad outcomes (a death, a burst of damage, a
  refused or wasted move, an interrupt that could not land in time, chasing out of range while
  hurt) and flag the decisions in the seconds before them.
- **Relabel and retrain.** Flagged states are labelled by Jev (a weekly credit budget) or by the
  user in the monitor (accept, or pick another option); every label records its source. They
  join the training set with extra weight. The fixed test sets and scenario suites decide
  whether a new checkpoint replaces the old one. Where Jev is systematically wrong, a rule from
  the game's mechanics corrects its labels, and the correction is recorded too.
- **Privacy and permission.** Other players' names and serials become stable pseudonyms before
  anything leaves the machine. Recording the user's own play needs no one's permission, but a
  shard may forbid proxies and third-party tools, so its rules are checked first and recorded
  in the shard profile. The bot itself plays only where "Playing on other shards" allows.

Order: the flight recorder, mistake rules and review queue on the local server first; then the
recording proxy against the local server; then an AOS shard (RunUO or ServUO family, like our
ModernUO) that allows it; a Sphere profile after that. Outcome-based training (M5) reads the
same logs.

## Training lifecycle

The game, the shards and what people want keep changing, so training is a routine with gates, not
a one-off:

1. **Change arrives** (a profile, a question format, a new template or tactic). First run the
   gates on the current model: fixed held-out agreement, the scenario suites, a live series
   against the scripted bot with decision time recorded. No gate fails, no training.
2. **Question format changed.** Carry the labels over (`distill convert`: drop what the new
   question no longer offers, renormalise, check a small fresh sample with the teacher); never
   serve a model with a question it was not trained on (v3 with the new mage question lost 0-40).
3. **Environment changed.** Relabel only the states whose text or options changed.
4. **From play.** Flight recorder, mistake mining, relabelling queue (above).
5. **Train** incrementally on everything kept (old data replayed against forgetting), a checkpoint
   per run, tagged on Hugging Face; promote only if every gate holds, keep the previous one to
   roll back to. Per-shard differences go into small adapters on one base model.

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
