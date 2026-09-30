---
license: other
license_name: pending-teacher-terms
language:
- en
pretty_name: neo-vs-morpheus duel decisions
tags:
- ultima-online
- game-ai
- decision-making
- distillation
- laya
task_categories:
- text-classification
size_categories:
- 1K<n<10K
configs:
- config_name: mage
  default: true
  data_files:
  - split: train
    path: data/mage/train.jsonl
  - split: test
    path: data/mage/test.jsonl
- config_name: melee
  data_files:
  - split: train
    path: data/melee/train.jsonl
  - split: test
    path: data/melee/test.jsonl
---

# neo-vs-morpheus: duel decisions labelled by Jev

Moments from Ultima Online duels, each written as a short English description, with the
full answer distribution of a teacher model (TypeSafe Jev 1.13, through FreeJev) over the legal
moves. Built to distil Jev's decisions into [Laya](https://github.com/NandhaKishorM/laya), a small
open "System One" decision model; see [neo-vs-morpheus](https://github.com/hakkisagdic/neo-vs-morpheus).

## Configs

| config | fighter | train | test |
|---|---|---|---|
| `mage` | PvP mage (spells: damage, interrupt, heal, cure, retreat, teleport) | 6,131 | 193 |
| `melee` | dexer (katana, bandages, potions) and archer (bow, bandages), special moves | 1,437 | 63 |

## Rows

| field | meaning |
|---|---|
| `id` | `run:<match file>:<decision>` for a state met in a recorded duel; `sampled:<seed>:<n>` or `melee:<seed>:<n>` for a generated one |
| `source` | `run` or `sampled` |
| `state` | the duel as the bot saw it: both fighters' health, mana, poison, casting, distance, recent events |
| `questions` | the typed question asked: one `choice` over every legal move, e.g. `damage:explosion`, `interrupt:magicArrow`, `defense:cure` for the mage; `attack:secondary`, `heal:bandage`, `cure:potion`, `throw:explosion` for fighters (only the moves legal in that state) |
| `teacher` | `model`, `probabilities` (option -> probability) and `inputTokens` of the teacher's answer |
| `teacher_choice` | the teacher's most probable option |

## How it was made

- **States.** Recorded duels on a local ModernUO shard (Mondain's Legacy rules, a flat
  synthetic arena, GM mage templates), mostly played by the fine-tuned Laya against itself and
  a scripted bot at 4, 8 and 12 tiles, plus states from a seeded sampler that covers rarer
  moments (poisoned, out of mana, opponent mid-cast, far or close). Deduplicated on the state text.
  Fighter states come from a seeded sampler over the dexer and archer templates (health,
  stamina, mana, bandage and potion timers, supplies, the opponent's weapon or spell).
- **Labels.** One request per state to Jev, which answers with a probability for every option.
- **Test split.** Labels added after the first checkpoint, chosen by the SHA-1 of their id (about
  1 in 25), so no released checkpoint trained on them.

## Known limits

- Mage templates and two fighter templates, one ruleset (Mondain's Legacy), synthetic arenas.
- The teacher is not always right: on twelve canonical duel moments Jev picks the accepted move
  in 9, on eight fighter moments in 6. It also tries to interrupt spells that land before any
  interrupt could (the opponent's spell lands in under 0.75 s in 2,081 mage states, and Jev's top
  pick is an interrupt in 2,034 of them). A student imitates these mistakes.
- 218 states come from duels in which a leftover NPC mage also fought; the state texts are still
  valid duel situations.

## Licence

The state texts and the code that made them are MIT. The teacher distributions are outputs of
TypeSafe Jev; this repository stays private until FreeJev and TypeSafe confirm that redistributing
them is fine. Ultima Online is a trademark of Electronic Arts; no game files are included.
