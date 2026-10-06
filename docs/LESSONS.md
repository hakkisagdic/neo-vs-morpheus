# Lessons from training Laya to duel

What a week of teaching a small decision model (Laya, ModernBERT-large, 421M parameters) to fight
Ultima Online duels taught us, with the numbers behind each lesson. The model picks a move per
decision from typed options; the opponent is a hand-written scripted bot; every number below is a
share of rounds won against it unless stated otherwise.

## 1. Measure before you believe a number

- **Speed decides duels before judgement does.** The scripted bot against slower copies of itself:
  no measurable effect up to ~200 ms per decision, 69% at 250 ms, ~80% at 400 ms or more. So every
  comparison runs at *matched speed*: the scripted bot reacts in 40 ms, close to Laya's own ~45 ms.
- **Latency hides in shared hardware.** Laya decides in ~36 ms on an M5 Max GPU, but 160-500 ms
  while a fine-tune shared that GPU. A cloud node came up without its GPU: Laya ran on the CPU,
  timed out on every request, and 63 runs held no Laya decision at all. Our own full-speed test
  suite, run on the arena machine, delayed the game servers enough to flag half of the runs in
  ten minutes.
- **Check every run, automatically.** A run is left out when Laya's median decision time passes
  600 ms, when casts arrive late (a starved game server), or when a model fighter never decided.
- **Compare side by side.** A candidate and the champion play the same series on the same machine
  in the same hours. A gate promotes or drops a candidate once both have 400 rounds, by a
  one-sided two-proportion z-test at 95%.

## 2. What did not make the model better

| version | recipe | rounds won | champion (v8) same hours |
|---|---|---|---|
| v8-dagger-all | v8 + scripted bot's labels on Laya's states (DAgger) | 42% | 55% |
| v9a | v8 + 17k outcome rows + melee DAgger | 49% | 63% |
| v10b | v8 + outcome rows from Laya's own games only | 43% | 63% |
| v11j-v15 | v8 + 2k-7k Jev answers on v8's own states | 30-53% | 60-66% |
| v12p-v15p | the same without v8's outcome rows | 28-39% | 60-66% |

- **DAgger needs an expert better than the student.** The scripted bot loses to v8; imitating it on
  v8's states made v8 worse.
- **Outcome rows** (decisions that turned out better than average) helped hard offline cases in an
  early version and hurt live play every time since.
- **Offline agreement is not strength.** Models with 0.82-0.90 held-out agreement with their teacher
  lost clearly. On its own states v8 picks the teacher's move only 56.5% of the time, against ~90%
  on its training labels: the states a model meets are not the states it learned from.
- **Before blaming the data, reproduce the champion.** v8 trained in 9 minutes on an A100; every
  version after it trained for hours on a T4 in fp16. Retraining v8's own set on today's pipeline,
  twice with different seeds, tells data effects from pipeline effects. *(Result pending.)*

## 3. Free and shared compute

- Free tiers cost in friction: quotas that end mid-run, a "GPU" node without a GPU, two GPU sessions
  per account (a third push fails with exit code 0), 30 GPU hours a week. A nine-hour arena on one
  of the two sessions blocked training for that long.
- A Kaggle GPU session has two T4s: train two versions at once, one per GPU.
- A shared production server takes work under rules (CPU caps by load, names, no ports); a keeper
  that restarts idle lanes from a plan keeps such machines busy without anyone watching.
- Caches matter for the people watching too: the dashboard re-read 1.3 GB of runs per refresh (20 s
  of empty page); a parsed index on disk brought a cold start from 90 s to 9 s.

## 4. The loop that runs itself

1. Lanes play the champion's own games; the scripted bot plays itself for variety.
2. A teacher (Jev) labels the champion's states while credits last.
3. Every 1,000 new labels, two versions are built and trained in one session.
4. Each finished version plays next to the champion; the gate promotes or drops it.
5. Every version, with its data's make-up, training, hardware and verdict, goes into MLflow.

## 5. Next

- Train on hardware like v8's (an A100-class GPU), and check the reproduction first.
- Improve the champion itself (fine-tune from v8's weights on its own games' outcomes) instead of
  re-imitating teachers from the base model each time.
