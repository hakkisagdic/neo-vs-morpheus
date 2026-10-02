---
license: apache-2.0
base_model: convaiinnovations/laya
language:
- en
tags:
- ultima-online
- game-ai
- decision-making
- laya
- system-one
pipeline_tag: text-classification
---

# laya-neo-duel

[Laya](https://github.com/NandhaKishorM/laya) `typed-decisions`, fine-tuned end to end (all 28
encoder layers and the decision head) to make Ultima Online duel decisions, as a mage and (from
v3) as a melee fighter, distilled from answers obtained through FreeJev, a third-party
Jev-compatible API (not affiliated with TypeSafe; its answers report Jev 1.13, unverified). Part of [neo-vs-morpheus](https://github.com/hakkisagdic/neo-vs-morpheus), where a
headless UO client asks it one typed question per move and a live monitor shows the answers.

## Versions

| version | FreeJev labels trained on | duel moments | movement moments | melee moments | held-out agreement with the teacher |
|---|---|---|---|---|---|
| base (not fine-tuned) | 0 | 0 / 12 | - | - | - |
| v1 (GitHub release `neo-duel-v1`) | 1,195 | 8 / 12 | 3 / 6 | 0 / 8 | 85.0% |
| `neo-duel-v2` | 6,131 mage | 11 / 12 | 3 / 6 | - | 94.3% |
| `neo-duel-v3` | 6,131 mage + 1,437 melee | 11 / 12 | 3 / 6 | 5 / 8 | 92.7% mage, 87.3% melee |
| FreeJev, the teacher | - | 9 / 12 | 5 / 6 | 6 / 8 | - |

Moments are canonical situations with agreed right answers (`bot/src/eval/scenarios.ts`);
agreement is on fixed held-out labels no version trained on. v1 beat its teacher 20-0 in live duels,
sides alternated: it decides in about 0.3 s on Apple silicon (Metal) against FreeJev's 3.2 s.

## Use

The folder is in Laya's own layout (`model.safetensors`, `encoder/`, `tokenizer/`,
`rl_agent_config.json`). From a clone of neo-vs-morpheus:

```bash
hf download hakkisagdic/laya-neo-duel --revision neo-duel-v3 --local-dir training/checkpoints/neo-duel-v3
scripts/laya-native.sh start training/checkpoints/neo-duel-v3     # laya-serve on :8001
```

Ask it the way the bot does: `POST /v1/systemone` with the duel state and one `choice`
question over the legal moves (`bot/src/brain/duel-policy.ts` for the mage,
`bot/src/brain/melee-policy.ts` for fighters).

## Training

RLCD objective as in Laya's own notebook: a proper-scoring-rule policy gradient plus soft
cross-entropy on the teacher's distribution. 4 epochs, batch 16, on a Colab GPU (about two
minutes for v1, 27 for v3 on an RTX PRO 6000). Temperatures fitted on held-out labels.

## Limits

Mondain's Legacy rules on a local ModernUO shard, synthetic arenas (open, pillars, a wall), GM
templates (mage, dexer, archer). It imitates its teacher, mistakes included: like its teacher it tries to
interrupt spells that land before any interrupt could, and unlike it it still chases an opponent
out of spell range when it should stop and heal. Outside the question format it was trained on,
expect Laya's base behaviour.

## Licence

Apache-2.0, like the base model. Trained on outputs obtained through FreeJev, a third-party API not affiliated with TypeSafe.
Ultima Online is a trademark of Electronic Arts; not affiliated with EA, TypeSafe AI or Convai
Innovations.
