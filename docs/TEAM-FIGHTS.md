# Fights with more than two (design)

One against two first, then 2v2 and 3v3. The duel stays the model's unit of thought: one
question per decision, legal options only, the code carrying the move out. What changes is that
every attack now has a target, and the text has to describe more than one opponent within
Laya's 512 tokens.

## The question: `action@target`

Options name their target: `damage:explosion@Morpheus`, `interrupt:magicArrow@Trinity`,
`defense:greaterHeal@self`, and in a team `defense:greaterHeal@Smith` for an ally. The legal
options rule is unchanged and applied per target, so the list stays short:

- an attack only on someone in range and in sight;
- an interrupt only on someone casting, and only while ours lands first;
- no cast at all that an incoming spell would break: the earliest disruption from *any*
  opponent counts (the duel's doomed rule, taken over every caster);
- hold and dodge as in the duel, dodge now towards cover from every caster at once;
- heals on an ally only within range and sight.

Two opponents and seven usable spells give about 15 options, as the duel does today; the
composite question already handles that size. A move without a target (chase, retreat, hold)
keeps its duel name.

## The text

One line per fighter, ours first, sorted by distance, in the duel's wording: health, poisoned,
casting what and landing when, what they wield, Protection, distance, sight. Then one line on
who is after whom, as far as the client can tell: damage we took and whose spell it was (the
spell words and the effect name the caster), and whom their last spell hit. About 60 tokens per
opponent leaves room for three.

## What the code needs

- **Several opponents in a controller.** `DuelController` keeps one serial today; it gets a list
  (and allies), and the snapshot gets `them: Opponent[]`.
- **Targets in plans.** `cast` and `attack` plans carry a serial; the caster and the attack
  already take one.
- **Tactics.** A focus rule a person can set (`focus: weakest | healer | caster | nearest`)
  that narrows the targets offered, the way bands narrow moves; and `vs` matchups per opponent.
- **The arena.** `[NeoTeam a,b vs c,d [distance]]` places two sides; the round ends when one side
  is down. Runs record every side's decisions as today.
- **Scoring outcomes.** Damage dealt and taken per bot over the horizon, and the round's result
  per side; credit for a kill goes to everyone who hit the target in its last seconds.

## Data and teacher

Jev labels the new questions (sampled 1v2 states, then states from runs); the duel's labels
stay valid for duels. Outcome rows follow from the first 1v2 runs, as in the duel.

## Measuring

1. Scripted 1v2 (one rules mage against two) to find a fair baseline: how long the one lasts,
   how often it takes one of them down.
2. Laya alone against two scripted mages, from both corners, kiting and cover on and off.
3. 2v2: two Laya bots against two scripted ones, then a caller that names the focus target.

## Order of work

1. Opponents as a list in the snapshot and controller, targets in plans (no model change: the
   duel keeps one opponent and behaves as now).
2. `[NeoTeam` on the server and team rounds in the match runner.
3. The `action@target` question and text, with tests on the legal options per target.
4. Jev labels, training, the measurements above.
