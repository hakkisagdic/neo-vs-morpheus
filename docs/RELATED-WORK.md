# Related work

Projects and recordings close to this one, with what each shows and how it bears on ours.

## autorokk's Ultima Online agents

The YouTube channel "autorokk" (repository owner johnpwrs on GitHub) drives Ultima Online with
large models through a ClassicUO fork of its own.

- **Navrey** — https://github.com/johnpwrs/navrey (BSD-2-Clause; our fork with the Apple Silicon fix:
  https://github.com/hakkisagdic/navrey, branch laya, set up by lab/navrey.sh). A ClassicUO fork that can be
  driven from a shell or an agent: the client writes its state to `/tmp/cuostate.json` and takes
  commands through `/tmp/cuocmd`, with or without a game window. It ships agent guides
  (`.claude/skills/`: log in, navigate, fight, loot, bank, shop, moongates, runebooks, death
  recovery) and two background scripts: a melee combat loop with pursuit, healing, looting and
  retreat, and a guarded walker. Built here natively for Apple Silicon (~/Projects/navrey); we
  plan it as the window onto our own server and, later, as the recorder of a person's own play.
- **The Jev duel videos** (16-19 September 2026, US Pacific dates), the ones that started this project:
  https://www.youtube.com/watch?v=cP-GWKteHKo, https://www.youtube.com/watch?v=t3eCkQY3Jk0
  (the "Jev Monitor"), https://www.youtube.com/watch?v=tjX3UoD7HPQ (Jev against Jev). TypeSafe
  gave the channel access to Jev; the server there is ServUO.
- **"Fable 5.1 Plays Ultima Online For 2+ Hours"** (8 September 2026, 2 h 10 min):
  https://www.youtube.com/watch?v=AS-_oidzefY. Claude Code with Fable 5.1 plays on the UOAlive
  shard through Navrey, told only to play however it likes. Over two hours it takes the New Haven
  trainer quests, gears up, hunts the undead of Old Haven, nearly dies to a skeletal knight and runs
  for town, restocks bandages and potions, reaches 50 Swordsmanship, cuts cloth into bandages,
  banks its loot, visits a festival and gates to Britain. Strategic play at a human pace: the
  fighting itself runs in Navrey's scripts.

What it means here: a large model plays well where seconds per decision are fine (where to go,
what to fight, when to run, restock or bank), which is the leveling and professions half of the
roadmap. Duels need decisions in tens of milliseconds, which is why a small trained model (Laya)
plays those. A large model playing whole sessions is a teacher candidate for the slow decisions:
record what it chooses where, and train small models on it.

All of autorokk's 20 uploads, with notes: [autorokk-videos.md](autorokk-videos.md).

## Decision models

- Laya (Convai Innovations, Apache-2.0): https://huggingface.co/convaiinnovations/laya, library
  https://github.com/NandhaKishorM/laya. Since 0.4.0 its router sends text it cannot classify to
  the multilingual model; this project pins 0.3.20.
- Jev (TypeSafe): https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Hugging Face Transformers: a slide seen on 2026-10-13 shows `transformers serve Qwen/Qwen3.8-27B`
  answering on `/v1/systemone`, the same API, which would make any open model a System One answerer:
  a candidate teacher, too slow to play a duel itself. Not tried here yet.
