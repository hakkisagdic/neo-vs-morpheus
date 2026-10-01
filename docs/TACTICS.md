# Tactics catalogue

Creative PvP and PvM tactics worth teaching the bot, collected from play. Each one records the
game mechanic it relies on (checked in ModernUO's source where possible; a Sphere shard may
differ), what the model decides, what the code does, and what it needs before it can be built.
Models decide what, code decides how: a tactic becomes a question option only when an executor
can carry it out and the game allows it at that moment.

Status: **live** (in the bot), **planned** (next milestone), **idea** (collected).

## Duel

**Magic Arrow pressure** (live). Fast 0.75 s arrows disturb the opponent's slower casts over and
over. A spell breaks only while it is being cast (`Spell.OnCasterHurt` checks `IsCasting`), so a
stream of arrows keeps disturbing their next spells even when each arrow is too late for the
current one. v1 beat the scripted mage 32-1 this way. The model picks the spell; the caster
casts.

**Interrupt in time** (live). Interrupt only when ours lands first: cast delay (2 + circle) × 250 ms
plus targeting, against their remaining cast time. Weaken breaks a spell too (`Weaken.cs` calls
`OnCasterHurt`). Enforced by the legal options of the mage question.

**Break line of sight** (live). Step behind a pillar or wall to heal out of sight; they cannot
target you either. `Grid.cover` finds the tile, the mover walks there.

**Explosion potion from range** (live, fighters). Throw from a few tiles so the burst does not
hit you; the range is a tactics setting.

**Cancel a doomed cast** (planned). A cast that will surely be disturbed (their damaging spell
lands before ours is done) or has lost its point (target out of sight, we must heal now) is
cancelled to win back the frozen time. On ModernUO equipping or using an item disturbs your own
spell (`DisturbType.EquipRequest`, `UseRequest`); a war mode toggle does not (the `Warmode`
setter never touches the spell), though on some shards it does: the shard profile names the
method. Code: detect the doomed cast, cancel it, decide again at once.

**Cast, then run** (planned). Casting freezes you until the cast delay is over
(`Spell.OnCasterMoving`: "You are frozen and can not move"); after that you may move while
aiming and while the spell travels. Chasing or fleeing, start the next step the moment the
freeze ends. The same window works against them: an opponent frozen by a cast cannot close in or
run for about its cast delay. Model: the state says how long each side stays frozen; code: the
timing. Done badly, you get caught or they get away.

**Hold or dodge a spell you cannot answer** (planned). When their damaging spell lands before any
spell of ours could finish, a cast now is wasted (it is disturbed as theirs hits). Hold: wait for
it to land, then cast at once. Dodge: a spell is checked again when its caster aims
(`Target`: out of range fails, out of sight answers "Target cannot be seen. Try again" and hands
the caster a new cursor), so stepping behind cover or out of range before it lands wastes a
caster that aims at once; a patient one holds the cursor and waits for you to show. Casting
freezes you, so an own cast is cancelled first. Model: `defense:hold` and `defense:dodge`,
offered only when every cast would be wasted and, for dodging, when cover or the edge of their
range is close enough to reach in time. Code: the steps to the nearest such tile, the run.

**Body block** (planned). Pushing through a player needs full stamina and costs 10
(`Mobile.CheckShove`); below full stamina the move is refused. So once a fleeing opponent has
used any stamina, standing in their way in a corridor, doorway or on a bridge stops them. Model:
a `move:block` option, offered when a chokepoint lies on their likely path. Code: predict the
path, reach the chokepoint first. Needs: our stamina in the state text, a corridor arena layout,
the real map for doors and bridges.

**Kite** (live; on against melee in the three profiles). Keep away from a melee opponent between
attacks; the tactics setting `kite` is the distance (0: off). On foot both sides run a tile per 200 ms
(`Movement.RunFootDelay`), so on open ground nobody outruns anybody: what kiting buys is the time
a melee fighter spends closing in. An archer runs while its bow reloads (a bow fires every 3.5 s
at 100 stamina, `BaseWeapon.GetDelay` under ML rules) and stops in time to stand still for the
250 ms a shot needs (`BaseRanged.OnSwing`); the server reports every shot (packet 0x2F), which
times the next. A mage runs while it cannot cast yet. Bows with Moving Shot (composite bow, heavy
and repeating crossbow) shoot on the move. Model: nothing new, it still picks the attack; code:
`Mover.kite` steps to the free tile farthest from them that keeps them in sight.
Measured on 1 October, scripted bots, 10 rounds from each side, kiting at 8 tiles against
none: the archer against the dexer went from 3-15 to 9-8 (draws aside), most rounds now ending
on time with the archer healthier. The mage against the dexer stayed at 0-20 but lived about
twice as long (86 s against 44 s): its trouble is the dexer's hits breaking its casts, which
distance does not fix. Protection should, since it stops every disruption (not yet measured).

**Fit the opponent** (live: matchups; planned: habits). A tactics file can hold changes for one
kind of opponent under `vs` (`melee`, `ranged`, `caster`), told apart by what they wield; values
set in the monitor override them all. A summary of what this opponent has done so far in the
state text ("poisoned you 3 times, runs when hurt") is still planned: it changes the state text,
so it needs new labels.

**Mind their Protection** (live). Under AOS rules Protection is a toggle that stops every
disruption by damage (`ProtectionSpell.Registry` holds 1000, that is 100%) and slows its owner's
casts by 0.5 s (two points of casting speed); it stays on through death until cast again. The
bot hears them cast it (Uus Sanct) and counts a completed cast as a toggle; a hit while it is
being cast breaks it, unless it is already on. While they are protected the question offers no
interrupt and their casts count 0.5 s longer; while we are, no cast of ours counts as doomed,
and ours count 0.5 s longer.

**Strip a reflection** (idea, shard rules). Before AOS, Magic Reflection reflects spells. Under
T2A rules it bounces the next spell whole and is gone (`SpellHelper.CheckReflect`), so a cheap
Magic Arrow first strips it before the real spell; under UOR rules it is a pool of 8 to 15
"circles" that every reflected spell drains by its circle plus one. Under AOS rules it reflects
nothing and trades physical resistance for the elemental ones, so it cannot be stripped. A shard
profile names the rule; the bot would track their reflection from the words it hears. ModernUO
can run with T2A or UOR rules (`NEO_EXPANSION`) to test it locally.

## One against two

**Split them** (planned, M3). Fight one at a time: stand so that cover blocks one of them.
Target the one who matters most first (a healer, the weaker one, the one casting). Know when to
leave. Uses the team question's `action@target` options.

## Team (2v2, 3v3, guild fights)

**Focus fire and the synchronised dump** (planned, M3). The caller names one target and every
bot times its cast so the spells land together, before heals can answer. Model: the caller's
focus question over visible enemies; each bot's `action@target` options. Code: cast timing.

**Peel** (planned, M3). Stop whoever is on our healer: paralyse, interrupt or body-block them.

**Interrupt the enemy healer** (planned, M3). Target selection that weighs who keeps the other
team alive.

## Open world (Order/Chaos, free-for-all, town and field)

**Flee into a dungeon, or give up the chase** (idea, M4). The target runs for a dungeon, a gate or
a guard zone. Model: the intent question (chase, stop, recall) with the chase risk in the state.
Tactics: chase risk tolerance, whether to follow into a dungeon. Needs: the real map.

**Bait and trap** (idea, M4). A "fleeing" opponent leads the chaser into their group or a
monster spawn. Model: read the signs (running towards other hostiles or into a spawn) and stop.
Tactics: how many unknowns ahead are too many.

**Escape** (idea, M4). Recall or Gate out, hide, or run, when health falls or when outnumbered.
Tactics: the health and head-count thresholds.

## Tamer and crafted help

**A golem in the backpack** (idea). A Clockwork Assembly in the pack builds a golem at your feet
on double-click: Tinkering 60 or more, the parts (Power Crystal, Gears and others) in the pack,
and a free follower slot; its strength scales from 60% to 100% with Tinkering
(`ClockworkAssembly.cs`). A tank and a body-blocker on demand. Model: when to deploy; code:
use the item and command the pet.

**Boxes on the ground** (idea). Tamers entering a spawn drop boxes to shape the monsters' path and
to break their line of sight. In ModernUO a dropped item blocks sight only if its tiledata has
the NoShoot or Window flag (`Map.LineOfSight`), and blocks walking if it is Impassable; which
boxes do that depends on the item's tiledata. Verify with the real client files; a Sphere shard
may treat items differently.

## Housing

**A house as a trap** (idea, M4). Someone flees into our house: its doors let in only people on
its access lists (owner, co-owners, friends; `HouseDoor.CheckAccess`), so a private house keeps
a chaser out or shuts a runner in, and pre-AOS houses use locks and keys instead
(`HouseDoor.UseLocks`). Inside, an owner or co-owner can turn, raise or lower locked-down and
secure items with the interior decorator (`InteriorDecorator`: up and down within limits) to
block a doorway or leave a runner stuck. Only in our own or our team's house. Model: when to
shut the door or build the block; code: the house gumps, the decorator targeting, the item
positions. Needs: the real map, a house on the local shard, and the owner's access.

## After the kill

**Loot, carve, or bring a friend back** (idea, M3 and M4). Loot the corpse when the map's rules
allow it (on an innocent's corpse it is a criminal act: `Corpse.IsCriminalAction`). Carving a
player's corpse turns it to bones and drops its limbs and a head, a bounty head when bounties are
on, with a criminal flag and karma loss for an innocent's (`Corpse.Carve`); on ModernUO it does
not stop a resurrection, which works on the ghost, but on some shards it does, so the shard
profile says. Bring a fallen friend back when nobody is close enough to punish it: the
Resurrection spell (8th circle) or bandages with enough Healing and Anatomy. Model: loot, carve,
resurrect or leave, weighed against the danger around; code: the corpse gumps, the item moves, the
targeting.
