# neo-vs-morpheus

An Ultima Online duel bot whose every move comes from a **System One** decision model: the
open-weights [Laya](https://github.com/NandhaKishorM/laya) running locally, or TypeSafe's
[Jev](https://typesafe.ai) in the cloud. Both speak the same API, so they are interchangeable
and can fight each other. A live **duel monitor** shows each decision with its probabilities,
the way the Jev UO demo that inspired this project did.

Everything runs locally in Docker: a [ModernUO](https://github.com/modernuo/ModernUO) shard, the
Laya server, and a headless bot client. No game client or EA files are needed to start: the
server falls back to a synthetic flat arena.

```
           ┌──────────── docker compose ─────────────┐
 bot  ─────┼─► uo-server   ModernUO + NeoArena overlay │  :2593
 (Node)    │                                           │
   │  └────┼─► laya        laya-serve /v1/systemone    │  :8000
   │       └───────────────────────────────────────────┘
   ├─────────► Jev          api.typesafe.ai or FreeJev
   └─────────► duel monitor http://localhost:8765 (next free port if taken)
```

## How it works

- **No screen reading.** The bot is its own UO client (`bot/src/uo`): it speaks the game's network
  protocol, so it receives exactly what ClassicUO receives (positions, health, poison, the power
  words an opponent is chanting, target cursors) and keeps that as structured state.
- **Typed questions, not prompts for text.** Each turn the duel state is written as a few lines
  of English and the model answers one `choice` question over every legal move
  (`damage:explosion`, `interrupt:magicArrow`, `defense:cure`, ...). The monitor shows the mode
  and per-mode distributions derived from it.
- **Guardrails.** Moves the game would reject or that make no sense (cure while not poisoned,
  not enough mana, poisoning a poisoned target, out of range) fall through to the next most
  probable legal move; each correction is shown on the monitor.
- **Retreat.** Besides heals and cure, a hurt bot may run out of the opponent's spell range to
  recover, as duel mages do.
- **Arena control.** A small C# overlay (`server/overlay`, compiled into ModernUO at image build
  time, upstream untouched) creates the owner account from the environment and adds GM commands
  the orchestrator uses: `[NeoDuel`, `[NeoTemplate`, `[NeoPrep`, `[NeoPlace`, `[NeoMage`, `[NeoClear`.

## Quick start

Requirements: Docker, Node.js 24+, git.

```bash
scripts/deps.sh sync                    # pinned ModernUO and Laya sources into vendor/
cp .env.example .env                    # set NEO_OWNER_PASS and BOT_PASSWORD
docker compose up -d --build            # ModernUO on :2593, Laya on :8000
cd bot && npm install
npm run nvm -- duel Neo:laya Morpheus:rules
```

Opponents: another bot (`Name:laya|jev|rules`), an NPC (`npc:EvilMageLord`), or a person playing
in ClassicUO (`human:CharacterName`). Other commands:

```bash
npm run nvm -- eval laya jev            # decision quality on canonical duel moments
npm run nvm -- bench laya               # decision latency
npm run nvm -- train Trinity --partner Tank --minutes 30   # level a bot's skills
npm run nvm -- login Neo                # create/log in a bot and report
```

### Laya natively on Apple silicon

Docker on macOS has no GPU, so the Laya container runs on the CPU (1-3 s per decision). Served
natively on Metal it answers in about 150 ms:

```bash
scripts/laya-native.sh start            # .laya/ holds the env, weights and log; clean removes it
# .env: LAYA_URL=http://127.0.0.1:8001
```

### Teaching Laya to duel

Out of the box Laya does not understand the duel (see Findings). The pipeline to specialise it:

```bash
npm run nvm -- distill states 1200      # recorded + sampled duel states -> training/data/
npm run nvm -- distill label            # the teacher's full answer distribution for each (Jev)
HF_HOME=.laya/hf .laya/venv/bin/python training/finetune.py            # Mac: decision head only
scripts/laya-native.sh start training/checkpoints/neo-duel             # serve the result
```

On a GPU the whole encoder is fine-tuned. With a Colab runtime connected through
[colab-bridge](https://github.com/hakkisagdic/colab-bridge), one command trains there (about two
minutes on an RTX PRO 6000) and brings the checkpoint home; `training/colab_finetune.ipynb` is the
manual route:

```bash
python3 training/colab.py all           # the runtime clones the local HEAD, so push first
python3 training/colab.py clean         # remove the clone and the log from the runtime
```

`training/data` and `training/checkpoints` are git-ignored. The 1,327 teacher labels and the
fine-tuned checkpoint are published as the
[neo-duel-v1 release](https://github.com/hakkisagdic/neo-vs-morpheus/releases/tag/neo-duel-v1).

Every match is saved to `runs/` with each decision and the state it was made from.

To remove everything, including the world save and model weights:

```bash
docker compose down -v --rmi local
```

## Findings so far

**Decision quality.** Twelve canonical duel moments whose right answer any duel mage agrees on
(cure when poisoned, break an Explosion being cast, heal when low, finish a nearly dead
opponent, ...), the same composite question to every model; no clock involved:

| model | right move (top-1) | probability on right moves | latency |
|---|---|---|---|
| Jev 1.13 (via FreeJev) | 9 / 12 | 61% | 3.3 s |
| Laya `typed-decisions`, not fine-tuned | 0 / 12 | 13% | 0.15 s (Metal) |
| Laya, decision head distilled from 1,195 Jev labels (on a Mac) | 4 / 12 | 30% | 0.25 s (Metal) |
| Laya, whole encoder fine-tuned on the same labels (Colab GPU) | 8 / 12 | 51% | 0.36 s (Metal) |

Out of the box Laya matches words rather than situations (a poisoned bot "chooses" Poison; an
opponent casting Explosion makes it cast Explosion), in line with Laya's own benchmarks where
the capability comes from fine-tuning. Training only the decision head (the encoder frozen, all
a 16 GB Mac can hold) moves it from 0 to 4 of 12. Fine-tuning the whole encoder takes it to 8 of
12, one short of its teacher, and it picks Jev's move on 74% of held-out states (6% before
fine-tuning, 51% with the head only).

**Live duels.** Speed decides a lot: a bot that thinks for seconds stands still while the other
one casts.

| Neo | Morpheus | score |
|---|---|---|
| Laya not fine-tuned, Docker CPU (1-5 s) | scripted baseline (< 1 ms) | 0-3 |
| Jev via FreeJev (3.3 s) | scripted baseline | 0-3 |
| Laya not fine-tuned, Metal (0.15 s) | scripted baseline | 3-5 |
| Laya distilled head, Metal (0.25 s) | scripted baseline | 4-4 |
| Jev via FreeJev (3.3 s) | Laya distilled head, Metal (0.25 s) | 1-2 |
| Laya fine-tuned end to end, Metal (0.27 s) | scripted baseline | 4-4 |
| Jev via FreeJev (3.2 s) | Laya fine-tuned end to end, Metal (0.26 s) | 5-5 |

Head to head, the fine-tuned Laya and Jev are level over ten rounds. Laya answers about twelve
times faster and gets 54 spells off to Jev's 30, but Jev's hits disturb a third of its casts;
Jev acts half as often and chooses slightly better (9 against 8 of the 12 moments above). So a
free local model that got none of those moments right out of the box, taught with 1,195 of
Jev's answers, fights Jev to a draw. The FreeJev proxy adds most of Jev's latency (TypeSafe
quotes 70-500 ms), and the samples are small.

## Real client files and ClassicUO

EA ships the Classic Client only as a Windows installer (`UOClassicSetup_*.exe` from
[uo.com](https://uo.com/client-download/)). Install it once on any Windows machine, copy the
folder to `server/client-files/` (or set `UO_DATA_DIR`), and the server uses the real world; the
same folder lets ClassicUO connect to watch or play. The files are EA's copyright and are never
committed or baked into an image.

## Dependencies and backups

Upstream sources are pinned by commit in `deps.lock`. `scripts/deps.sh backup` writes full-history
git bundles to `backups/`; `scripts/deps.sh sync` restores from them if an upstream disappears.

## Licenses

The bot and scripts are MIT (see `LICENSE`). `server/overlay` is compiled into ModernUO and is
therefore GPL-3.0-or-later like ModernUO. Laya is Apache-2.0. Ultima Online is a trademark of
Electronic Arts; this project is not affiliated with EA, TypeSafe AI or Convai Innovations.
Use bots only on servers you run or that allow them.
