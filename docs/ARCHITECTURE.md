# Architecture

How the pieces fit: five layers, each replaceable on its own, the same in Ultima Online as in the
business flows this method is meant for later (a small trained model per decision point, rules in
code). Two ways into the game share the layers above perception.

```
             +---------------------------------------------------------------+
  5. data    |  every decision recorded once: state, question, options,      |
     loop    |  choice, probabilities, outcome -> labels -> training ->      |
             |  gate and bench -> the next champion                          |
             +---------------------------------------------------------------+
  3. slow    |  strategist: a large model with game tools only               |
     strategy|  (where to go, what to fight, with which tactics)             |
             +--------------------------+------------------------------------+
  2. fast    |  Laya: typed questions, ~40 ms a decision, one fine-tuned     |
     judgement  model per decision point; tactics bound what it may choose  |
             +--------------------------+------------------------------------+
  4. code    |  legality, guardrails, tactics bands, execution of the plan   |
             +--------------------------+------------------------------------+
  1. perception  the world as typed data | bot path: the protocol            |
             |  game facts as data      | game path: Navrey's state files   |
             +--------------------------+------------------------------------+
```

## 1. Perception: the world as typed data

The protocol gives every creature's identity, place, health and kind exactly, so nothing here
guesses from pixels. Screens (vision) are for where no data exists: a shard that allows only its own
client, a video of someone's play, other games. When that time comes, the structured channel labels
screen frames for free (we know where every creature stands), so a small detector can be trained
without hand labels.

- Bot path: `bot/src/world/world.ts`, the packet client's world model.
- Game path: Navrey (`~/Projects/navrey`, our fork `hakkisagdic/navrey`, set up by
  `lab/navrey.sh`) writes `/tmp/cuostate.json` and `/tmp/cuoworld.json`.
- Game facts as data, not in models: `data/bestiary.json` (`lab/bestiary.py`, creatures' stats from
  ModernUO's source), POIs (`lab/poi.py`, places from the server's regions and spawners),
  `templates/`, `tactics/`, shard profiles (`docs` of the shard rules).

## 2. Fast judgement: Laya

A non-generative decision model (`POST /v1/systemone`): choice, score and yes/no questions over the
state written as text, answered with probabilities in tens of milliseconds. One fine-tuned
checkpoint per family of decisions (duel mage, melee, skill training), served by
`training/serve_checkpoint.py`.

- Question formats: `bot/src/brain/duel-policy.ts` (mage), `bot/src/brain/melee-policy.ts`
  (fighters), `bot/src/game/train-brain.ts` (skills). A format change means a new version
  (`FORMAT`, `MELEE_FORMAT`) and converted labels: a model is served with the format it learned.
- The model chooses only among legal options; the guardrails remove the rest first.

## 3. Slow strategy: the strategist

A large model plays whole sessions with game tools only (no shell, no files):
`lab/uo_agent.py` gives it `look`, `command`, `wait`, `decide` and, with `--laya`, `fight`, which
hands one creature to Laya and returns how it ended. Local models through Ollama (Gemma 4), Claude
through Claude Code with these tools over MCP (Fable, asked for each time).

## 4. Code: rules and execution

Hard rules stay in code: what the game allows (`blocked*` in the policies), money and safety, the
tactics' health bands, chase limits and keep-up spells (`bot/src/brain/tactics.ts`, `tactics/*.json`).
Execution is code too: the bot path's `bot/src/game/duel.ts` (packets), the game path's
`bot/src/navrey/fight.ts` (Navrey's commands). "The model judges, the code acts."

## 5. The data loop

- Recording: arena runs (`runs/`, one JSON per match, every decision with its snapshot), agent
  sessions (`~/UO/sessions/<stamp>-<player>/`: decisions with what the character saw, Laya's fights
  with whole states, the state stream, `session.mp4`), PvE tracks (`~/UO/pve/`).
- Labels: a teacher (Jev, an oracle computed from the game's formulas, outcomes); `bot/src/distill/`.
- Training: `lab/trainer.py` (Colab, Kaggle), checkpoints as tags in the private Hugging Face repo.
- Promotion: the gate (`lab/trainer.py`, stratified run-level test) and UO Bench (`bench/`,
  `docs/BENCH.md`); a candidate keeps every skill the champion trains.
- Upkeep: `lab/tidy.py` (daily at 04:00: lossless compression of runs, unused checkpoints, Docker's
  old cache), `lab/upstream.py` (Laya and Jev releases).

## Two ways into the game

| | bot path | game path |
|---|---|---|
| client | headless TypeScript (`bot/`) | Navrey, a ClassicUO fork with a window |
| map | synthetic arena | EA's client files (the real world) |
| scale | dozens of parallel lanes (Mac, alastyr, Colab) | one client per machine |
| for | duels, gates, benchmarks, training data at volume | agent sessions, PvE tracks, videos, recording a person's play |
| execution | `game/duel.ts` | `navrey/fight.ts` |

Both ask Laya the same questions with the same guardrails and tactics, so a model measured on one
path behaves the same on the other.

## Where it is going

The strategist's frequent decisions (which creature, which hunting ground, when to heal or bank)
become typed questions for small models too, labelled by outcomes and by an oracle computed from the
bestiary; the large model keeps the open-ended planning. Controlled tracks come first (the arena PvE
track, `lab/pve_arena.py`; a training ground), the open world is the exam.
