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
npm run nvm -- login Neo                # create/log in a bot and report
```

Every match is saved to `runs/` with each decision and the state it was made from.

To remove everything, including the world save and model weights:

```bash
docker compose down -v --rmi local
```

## Findings so far

Canonical duel moments whose right answer any duel mage agrees on (cure when poisoned, break an
Explosion being cast, heal when low, finish a nearly dead opponent, ...), same question to both:

| model | right move (top-1) | probability on right moves | avg latency |
|---|---|---|---|
| Jev 1.13 (via FreeJev) | 9 / 12 | 61% | 3.3 s |
| Laya `typed-decisions`, not fine-tuned (Docker, CPU) | 0 / 12 | 13% | 1.3 s |

Out of the box Laya matches words rather than situations (a poisoned bot "chooses" Poison; an
opponent casting Explosion makes it cast Explosion). That matches Laya's own benchmarks, where
the capability comes from fine-tuning. The next step is fine-tuning Laya on duel decisions
(distilled from Jev and the recorded runs).

Live duels against the scripted baseline, which decides in under a millisecond, are decided by
latency for now: Laya (CPU, 1-5 s per decision) and Jev through the FreeJev proxy (about 3.2 s;
the demo that inspired this ran at about 0.3 s) both lost 0-3.

Docker on macOS has no GPU access, so Laya runs on the CPU here (about 1-3 s per decision);
native Apple-silicon inference is much faster.

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
