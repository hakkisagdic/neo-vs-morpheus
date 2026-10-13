# autorokk's videos

A reference catalogue of every upload on the YouTube channel **autorokk**
(https://www.youtube.com/@autorokk, channel ID `UCvD25CKcOKDMXi5t2jRrw2A`), whose author is the
GitHub owner johnpwrs, maker of [Navrey](https://github.com/johnpwrs/navrey). Collected on
2026-10-13: 20 uploads, 19 videos and 1 Short. The channel has no live streams, playlists or posts.
Machine-readable list with view counts: [`research/autorokk/videos.json`](../research/autorokk/videos.json).

How it was read: the metadata embedded in each watch page (title, date, length, description,
tags), the comment threads, where the author's replies carry most of the setup detail, and the
thumbnails and storyboard preview frames for what is on screen. Transcripts could not be fetched,
so narration is covered only where descriptions, comments or on-screen text show it. Dates are the
publish dates YouTube displays (US Pacific); the JSON keeps the full timestamps.

The channel has two eras. Until January 2026 it is a Unity devlog for a game with Ultima Online's
look. From August 2026 it is about agents playing and building in UO through Navrey: Claude models
first, then TypeSafe's System One model Jev.

Links that appear in descriptions and comments:

- Navrey: https://github.com/johnpwrs/navrey (BSD-2-Clause, created on GitHub on 26 August 2026;
  only a `main` branch is public).
- TypeSafe: https://docs.typesafe.ai/introduction (first Jev video) and
  https://typesafe.ai/blog/introducing-system-one-models-and-jev (an author reply).
- The author's Discord invites, as posted in comments: https://discord.gg/zhQVaQBKV (early 2026,
  Unity game) and https://discord.gg/m5ArGy9SC (October 2026, Navrey).

---

## Stormwind in Ultima Online?

2026-09-29 · 3:56 · https://www.youtube.com/watch?v=_AOYGhrv9fE

A tour of a World of Warcraft–style Stormwind built inside UO. In a comment reply the author
explains the setup: Claude Code drove an admin character through Navrey on a local ServUO shard,
starting from AI-generated concept art and a single prompt, and he then refined the rough first
result in natural language only, without placing a tile himself. The model is not named; the tags
mention Opus. The video first compares the concept art, the one-shot attempt and the iterated map
renders, then walks the finished city: walled districts with colour-coded roofs, canals and
bridges, a gold-roofed cathedral and a harbour.

Useful for us:
- Building scenery by instruction with a staff character is a cheap way to make purpose-built
  arenas on our own server (duel pits, corridors, line-of-sight blockers) for UO Bench tasks and
  course scenes.
- "Concept art, one-shot, iterate with renders" is a clear demo structure; the one-shot versus final
  comparison shows why the feedback loop matters.
- From the comment thread: Navrey's `target` took only a serial or `self`, which blocks
  ground-targeted actions (Teleport, mining, chopping). A `targettile` command now covers this in
  Navrey's main branch; we need it if we cast such spells through Navrey.

## Building King's Landing in Ultima Online with Opus 5.5 and Navrey

2026-09-25 · 8:23 · https://www.youtube.com/watch?v=Ug2qrKrA2f0

A bigger follow-up to the world-building video: a King's Landing from Game of Thrones, a walled
harbour city with a red castle on a rocky spur, built by Opus 5.5 in Claude Code through Navrey
from an AI-generated concept image. The narrated video sets the concept art beside an overhead
render of the finished map, shows the Claude phone app with the agent reporting progress on ground,
houses, walls and shoreline, and then tours the city in game. In a comment reply the author says
the city stayed dense and narrow for most of the build and that he widened it and spaced the
buildings at the end to match the concept art. He presents it as a demonstration of tools and
workflow rather than of the map: the agent places every tile while a person with a vision directs.

Useful for us:
- An overhead render compared with a reference image is a quick progress check, usable for
  generated arenas or for reviewing bot paths.
- The roles are the ones we want in our own decisions: the machine does the work, a person makes
  the judgement calls. The concept-versus-result image makes the point on one slide.

## Ultima Online World Building with Claude and Navrey

2026-09-22 · 10:09 · https://www.youtube.com/watch?v=VinDltuoA0k

The first world-building test, recorded live. A title card shows the only prompt: the agent is
logged in as an administrator on the author's private server and should turn a fenced field into
a small spooky Halloween village, with cabins along the fence, a fountain in the middle and
scattered trees, checking its work with a screenshot tool. For about six and a half minutes the
game sits next to the Claude Code terminal while the fountain goes in, then the cabins one by one,
then the decorations; from 6:35 the result is toured (pumpkins, cobwebs, graves, skeletons,
braziers). The description names the stack as Claude Code, Navrey and ServUO; the model is not
named.

Useful for us:
- A screenshot tool lets the agent look at what it built and correct it; a teacher model that sets
  up arenas or reviews bot positioning could use the same loop.
- The format (prompt card, raw first attempt, then the result) is honest and easy to copy for
  course recordings.

## Jev AI vs Jev AI Ultima Online Duels

2026-09-19 · 4:09 · https://www.youtube.com/watch?v=tjX3UoD7HPQ

A compilation of mage duels in which TypeSafe's Jev controls both characters on a stock local
ServUO shard, choosing every spell, every step, and when to heal, cure or interrupt. Per the
author, Randall is a halberd mage with 100 Magery and Evaluating Intelligence, and Hal a pure mage
with 120 in both to make up for having no weapon. Each side has a duel monitor page on localhost:
the decision (mode, spell, target, tile and a one-line reason), scored options for the mode
(damage, defense, interrupt) and for each spell family (damage spells such as lightning,
explosion, poison and teleport; cure and heals; harm, weaken and magic arrow to interrupt), and
both sides' health, mana, poison, casting state, last cast (fizzles included), distance and line
of sight. One frame reads 230 ms for a decision with about 9,200 tokens in and 330 out, model
`jev-1.13.0`. Viewers found poison overtuned and the Teleport plays striking; the author agreed
about poison and said Greater Cure still had to go into the rotation.

Useful for us:
- The question layout (one mode question, one per spell family, plus a tile) is close to our typed
  decisions and a good reference for the duel lane; the 230 ms, 9k-token frame is a reference point
  for latency comparisons with Laya.
- The monitor, with state on one side and scored answers on the other, is the view our own duel
  viewer and course slides should have.
- Pitfall: in ServUO a cast moves a weapon without Spell Channeling into the backpack (with
  `Spell.ClearHandsOnCast` true, the spell calls `Mobile.ClearHands`), yet a viewer noticed the
  halberd never came off. Check such rules on our server before comparing results.

## Jev Playing Ultima Online - Prominently Displaying the Jev Monitor UI

2026-09-18 · 5:44 · https://www.youtube.com/watch?v=t3eCkQY3Jk0

More Jev PvM, this time with the Jev monitor at full size next to ClassicUO, so the input and output
of each decision can be read while the character fights orcs around an orc fort and in the woods
nearby. One column shows what Jev was given: the player (health with a ten-second damage trend,
bandage timer and count, poison, position, time since the last hit and swing, what the previous
tick did), the current target, potential targets with unreachable ones struck off, unlooted
bodies, and the open tiles with a short note each. The other shows what Jev answered: the decision
with its confidence and a one-line reason, score bars for the next action (explore, choose a new
target, flee, loot, fight the last target, use a bandage), and the target, position and loot
rankings, each marked as not asked when there is nothing to choose from. One frame reads 194 ms
for a decision with about 3,600 tokens in and 150 out, the log shows roughly one decision a second,
and collapsible panels hold the questions as sent and the raw answers.

Useful for us:
- Ask a question only when it has candidates: skipping the target or loot question saves tokens
  and avoids forced choices.
- State engineering worth copying: a damage trend over a window, unreachable targets struck off,
  a note per tile (new ground, current spot).
- Keep the raw questions and answers one click away in any viewer we build; that is what makes a
  decision debuggable.

## Jev as the combat AI for Ultima Online

2026-09-16 · 2:53 · https://www.youtube.com/watch?v=cP-GWKteHKo

The first Jev video. With early access to TypeSafe's System One model, the author replaced his
deterministic combat script with Jev's live decisions in a dungeon hunt (the frames show earth
elementals), shown beside a combat monitor he built with Claude. As he explains in the description and in comment
replies, the bot sends the game state as structured JSON to the hosted Jev API (player vitals,
position and poison, inventory such as bandage count, visible targets with coordinates, type and
health, walkable tiles in view, unlooted corpses) and asks several multiple-choice questions in one
request: which tile to stand on (the player moves there every turn), what to do (fight, flee, heal,
loot, explore), which target first, which corpse to loot and which items to take from it. Jev
therefore drives all movement, fleeing when low, chasing targets that run, and going deeper when
nothing is left. He adds that Claude, like other LLMs, was far too slow for decisions inside a
fight and only chose when to start and stop fighting, while Jev answers questions rather than
generating text; one frame reads 313 ms for a decision with about 6,000 tokens in.

Useful for us:
- The same architecture as ours (state in, typed questions out, positions as tile choices); his
  question list is a checklist for our PvM and levelling lanes.
- The layering of a large model for when to fight and a fast model for the fight matches our plan
  of a large model as teacher for the slow decisions.

## Fable 5.1 Plays Ultima Online For 2+ Hours

2026-09-08 · 2:10:25 · https://www.youtube.com/watch?v=AS-_oidzefY

Claude Code with Fable 5.1 plays a new character on the UOAlive shard through Navrey for over two
hours, told only to play however it likes. It works through the New Haven trainer quests, trades a
Young Player ticket for starter armour, hunts undead around Old Haven, nearly dies to a skeletal
knight and runs for town, restocks bandages and potions, reaches 50 Swordsmanship, cuts cloth into
bandages, banks its loot, visits a festival on the shard, and finally gates to Britain to look for
people and hunt at the cemetery. The thumbnail shows how: a background melee script does the
fighting, while Claude, in auto mode with a goal set, watches the script's output through
persistent monitors filtered to escapes, handoffs and player chat, and decides where to hunt, when
to leave and what to buy. The description's chapter list time-stamps each step.

Useful for us:
- A reflex script with a supervising model, woken only by escapes and handoffs, is a template for
  our levelling and professions lanes.
- Two hours of strategic choices is the record we want from a teacher model; logging each choice
  with its state would turn it into training data.
- Pitfall shown: the near-death came from a mob stronger than the script's usual targets, so escape
  and heal rules have to live in the fast layer.

## Claude Plays UO - Singing songs to players at West Britain Bank

2026-09-04 · 2:45 · https://www.youtube.com/watch?v=fsXLxis1XU8

A light-hearted clip. After a long instruction typed into Claude Code, the agent's character
stands in the crowd at West Britain Bank on a busy public shard and sings songs to the players,
one overhead line at a time. The verses refer to what it can see on them, such as a Cu Sidhe mount
and an anniversary cloak. Neither the model nor the shard is named; the client was not public yet,
and the author linked Navrey in the comments once it was.

Useful for us:
- Reading other players (Navrey later published a skill for paperdolls, gear and titles) and
  pacing speech are a capability separate from fighting, useful for companion or tutor demos.
- Keep such demos on our own server: an agent talking to strangers on a public shard raises
  courtesy and rules questions.

## Ultima Online Hands-Free with Claude Code Remote Control + Voice Dictation

2026-09-01 · 4:58 · https://www.youtube.com/watch?v=Bb30ucvV_vo

The author plays from the couch by voice, dictating into the Claude phone app, which is connected
by Remote Control to the Claude Code session on his Mac that runs the client. His character starts
in the Britain sewers; he asks it to go and hunt at the Britain cemetery, and the agent answers with
progress notes (walking to a staging point, loading its combat skill on the way) while the game
shows the walk and the fights. The app's model picker reads Opus 5, and a webcam inset shows him
with the phone.

Useful for us:
- Remote Control from a phone is a practical way to watch and steer long runs on our machines.
- Starting the walk as a background task and preparing the next skill meanwhile is a small
  latency trick worth reusing.

## Claude Plays Ultima Online - The Ultimate UO Assist?

2026-08-27 · 4:41 · https://www.youtube.com/watch?v=84cGLqFoc40

The pivot that led to Navrey. The author's headless, text-only CLI for Claude became a ClassicUO
mod: the agent drives the same window a person plays in, the person can stop it and carry on, and
a headless mode remains. In the demo Claude Code, open in an editor panel, gets one instruction for
a fresh archer (dress, make bandages, buy arrows, go to the sewer entrance, report back) and works
it out with task skills for buying and navigation and CLI calls such as walking to a named shop; the
slow start of a new session is sped up. The author stresses that he did not tell it where bandages
come from, where arrows are sold or how to reach the sewers; a new point-of-interest lookup built
from third-party map data answers the where. He also sees accessibility potential in speech-driven
play.

Useful for us:
- A point-of-interest lookup from published shard marker data (Navrey's `uo-poi-data` converters)
  is what our levelling and professions lanes will need for "go to the nearest X".
- Shared control in one client, agent plays and a human takes over, is the set-up we plan for
  recording a person's own play.
- Packaging know-how as per-task skills (buy, navigate, bank) is a reusable pattern for the course.

## Getting Ultima Online's Open World Running in Unity

2026-01-22 · 5:32 · https://www.youtube.com/watch?v=jrBryt3RyCk

A narrated, deliberately educational devlog for the author's Unity game with UO's look. It goes
through three passes: placing tiles by hand on a Unity tilemap, reading real UO map data into
generated meshes, materials and tilemaps saved as prefabs, and finally streaming the open world in
chunks. It explains chunk coordinates (tile position divided by chunk size, rounded down), a lookup
from chunk to contents, loading the chunks around the player, and hysteresis, with a thermostat
analogy, so chunks at the edge do not flicker in and out. In the comments the author gives the goal:
not an MMO but a large-map, team-against-team, matchmade PvPvE game.

Useful for us:
- Hysteresis applies directly to decision thresholds (flee and return, heal and fight) so a bot
  does not oscillate; the thermostat analogy is ready-made course material.
- Chunking the map is a natural way to cap the tile list we send to a decision model.

## Instant Ultima Online Maps and Animations in Unity

2026-01-03 · 8:40 · https://www.youtube.com/watch?v=0FHf7StAG-A

The author introduces the game he is building and then two Unity Editor tools he wrote for it. One
turns regions of the UO map (land, statics, buildings, water) into Unity tilemaps and prefabs; the
other imports UO animation data as clips and animation controllers. Both are shown working inside
the Unity editor, with narration.

Useful for us:
- Shows what UO's client data files make possible once we have them (map rendering, animation),
  for replays or course visuals outside the game client.

## Multiplayer Lobbies using AWS GameLift

2025-12-26 · 0:56 · https://www.youtube.com/watch?v=2NCMg5k-3yQ

A short devlog clip of a rough lobby screen for the Unity game, creating and joining lobbies
through AWS GameLift. It was recorded with two Unity editors running side by side, and the author
notes that the recording load makes it look choppier than it plays. Nothing about agents or UO
servers.

Useful for us:
- Nothing for the bot; listed for completeness.

## Instant Ultima Animations in Unity using Custom Editor Tool

2025-12-22 · 1:23 · https://www.youtube.com/watch?v=Uu2U94gFQWM

A demonstration of the Unity Editor tool that reads UO animation files and, with one button,
produces clips for every action and direction of monsters, players and equipment, the transitions
between them, and keyframe events such as footsteps for sound. Only the art comes from UO;
everything else is rebuilt the Unity way. It is the animation half of the tools shown again in
January 2026.

Useful for us:
- If we ever render bot replays outside the client, this is the route from UO animation data to
  playable clips.

## Ultima Online Unity (Multiplayer) Demo

2023-01-15 · 1:15 · https://www.youtube.com/watch?v=yWQYoPzQydc

A short multiplayer demo of the Unity project: a first customizable action bar (modelled on
Divinity: Original Sin 2 on console and on Fortnite), sound effects, and a spell fizzling when the
caster is interrupted. In a comment under the Xbox video the author points to this demo and
describes the vision at the time, a MOBA-like team PvP game with UO's movement and casting where
you build a character instead of picking a hero. The art is taken directly from UO.

Useful for us:
- An early sign of the mage-PvP mechanics (pre-casting, interrupts) that later drive the Jev
  duels; background for a course history slide.

## Ultima Online in Unity with Multiplayer

2022-12-31 · 1:45 · https://www.youtube.com/watch?v=IkaJC7W4aKk

Multiplayer through Unity Netcode for GameObjects, with mana and hit point regeneration, a death
animation, heal and resurrection spells, and spell fizzling on interrupt. It also adds controller
support: a bumper cycles targets, the face buttons cast, holding the left trigger switches to a
second set of spells, and the right trigger releases a spell on the target. It builds on the
targeting and pre-casting prototypes from 2021.

Useful for us:
- Mage combat squeezed into a handful of controller actions (cycle target, pick a spell, release)
  is a neat picture of a small discrete action space like a bot's.

## Clayton or not app

2022-04-12 · 0:52 · https://www.youtube.com/shorts/UfYqYEnxVxI (Short)

Not about UO. A phone screen recording of a joke app: pick a photo from the library and it answers
whether the person in it is "Clayton" or not, in the spirit of the "hot dog or not hot dog" app. It
is the channel's only Short.

Useful for us:
- None; listed for completeness.

## Ultima Online in Unity playing on Xbox Demo

2022-01-05 · 2:24 · https://www.youtube.com/watch?v=7_QTFivspfU

The author's Unity UO client running on an Xbox One, connected to the official Atlantic shard with
movement synced tile for tile. It reads UO map data and speaks the UO network protocol through his
own callback-based networking library, so the Unity side only registers callbacks against a
higher-level layer; map and item data were converted from the .mul files to JSON and the art packed
into sprite sheets on Unity's 2D tilemap. Only land and statics are drawn, some art is missing, and
the height (z) conversion still has edge cases. In a later comment he says he dropped the client
idea for a new UO-inspired game, partly because ClassicUO now runs on the web.

Useful for us:
- The protocol layer as callbacks behind an abstraction is also the design of our headless
  TypeScript client, a good comparison for the course.
- Pitfall: custom clients are forbidden on official servers (Navrey's README says so too); our
  work stays on our own servers.

## Ultima Online Unity

2021-04-13 · 0:54 · https://www.youtube.com/watch?v=_MsnoJDXSVY

An early prototype clip from the Unity project. It adds an action bar and improves tab-style
targeting over the clip from two days earlier. It is a hand-played prototype with no agents
involved.

Useful for us:
- Nothing for the bot; background on the author's path to UO tooling.

## UO Unity. Pre casting and tab targeting

2021-04-11 · 0:55 · https://www.youtube.com/watch?v=5ry3npVaduw

The earliest UO clip on the channel, a hand-played Unity prototype. It shows spells cast in advance
and released later, switching targets with Tab, a target marker that changes when a spell is ready
to release, and spell words over the caster's head as in UO. Asked in the comments, the author
confirms that the models and animations can be swapped for others.

Useful for us:
- Pre-casting and then targeting is the core timing problem of a mage duel, the same one our duel
  bot has to solve.

---

## Patterns across the videos

- **Two phases.** From 2021 to January 2026, hand-built Unity devlogs for a game with UO's look.
  From 27 August 2026, agents playing and building in UO through the author's ClassicUO fork,
  published as Navrey.
- **Slow brain, fast reflexes.** Large models (Opus 5, Fable 5.1, Opus 5.5) do the slow work:
  quests, shopping, routes, world building. Deterministic scripts did the fighting until Jev took
  over combat, answering multiple-choice questions over JSON state in roughly 200 to 300 ms per
  decision. The author's stated reason is speed: LLMs are too slow inside a fight.
- **Everything is observable.** Each agent video puts the agent's reasoning or decisions next to
  the game: the Claude Code terminal, or the Jev monitor with the state in, scored answers out, a
  reason, latency and token counts. Our own videos and course should copy this format.
- **Capability comes from tools.** Per-task skills, a point-of-interest lookup, screenshots for
  self-checking, `targettile` for ground targets; the agent strings basic client commands together
  by itself.
- **People stay in the loop through the interface.** Take over in the same window, steer from a
  phone, dictate by voice.
- **Servers.** The Claude play videos use a public shard (UOAlive is named in the Fable video); Jev
  and the world building use a local, stock ServUO with an admin character. The 2022 Unity client
  connected to the official Atlantic shard.
- **What is missing.** No training or learning (Jev is used as is through its hosted API), no win
  rates or repeated trials, and the Jev integration is not published: Navrey's public repository
  has only its main branch, and the author mentions a separate Jev branch. Viewers keep asking for
  the Jev setup.
