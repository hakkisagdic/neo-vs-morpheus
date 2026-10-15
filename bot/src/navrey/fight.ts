// A fight played inside the real game through Navrey (the ClassicUO fork an agent drives through
// files) by a duel brain: the same snapshot, question and guardrails as on the arena lanes, read from
// Navrey's state files and carried out with its commands. A strategist (lab/uo_agent.py's `fight`
// tool) starts one against a creature and gets back how it ended, so that a large model chooses what
// to fight and with which tactics, and Laya makes every move of the fight.
import { appendFileSync, closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { Tactics } from "../brain/tactics.ts";
import { tacticsFor } from "../brain/tactics.ts";
import type { Decision, DuelBrain, DuelSnapshot, Plan, Supplies, WeaponView } from "../brain/types.ts";
import { creatureFor, danger } from "../brain/bestiary.ts";
import { MELEE_FORMAT, weaponSkill } from "../brain/melee-policy.ts";
import { GRAPHIC, HEAL_POTION_DELAY_MS, WEAPONS, abilityMana, selfBandageSeconds } from "../game/items.ts";

const FILES = {
  cmd: process.env.NAVREY_CMD ?? "/tmp/cuocmd",
  log: process.env.NAVREY_LOG ?? "/tmp/cuolog",
  state: process.env.NAVREY_STATE ?? "/tmp/cuostate.json",
  world: process.env.NAVREY_WORLD ?? "/tmp/cuoworld.json",
};
const STAMP = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /;
const TICK_MS = 300;
/** Time to reach a target for the first time; the tactics' chase limits count only after that. */
const APPROACH_MS = 20_000;
/** Monsters fight with what they are; these cast (Navrey does not say which do). */
const CASTERS = /mage|lich|wisp|gazer|imp\b|daemon|elemental|shaman|necromancer|sorcer|wraith/i;

type NavreyItem = { serial: string; name: string; graphic: number; amount: number; layer?: string };
type NavreyMobile = {
  serial: string;
  name: string;
  species: string | null;
  x: number;
  y: number;
  z: number;
  distance: number;
  hits: number;
  maxHits: number;
  isDead: boolean;
  isHuman: boolean;
  graphic?: number;
};
type NavreyState = {
  updatedAtMs: number;
  charID: string;
  charName: string;
  charPosX: number;
  charPosY: number;
  charPosZ: number;
  charGhost: boolean;
  isPoisoned: boolean;
  isYellowHits: boolean;
  warMode: boolean;
  hits: number;
  maxHits: number;
  stamina: number;
  maxStam: number;
  mana: number;
  maxMana: number;
  dex: number;
  equipped: NavreyItem[];
  backpack: NavreyItem[];
  lastAttack: { kind: string; serial?: string };
  nav: { active: boolean; status: string };
  physicalResistance?: number;
};

/** Navrey's `skills` lines ("[SKILL] Swordsmanship      50.0 (base  50.0) up") as {name: value}; none when it said nothing. */
export function parseSkills(lines: string[]): Record<string, number> | undefined {
  const skills: Record<string, number> = {};
  for (const l of lines) {
    const m = /^\[SKILL\] (.+?)\s+(\d+(?:\.\d+)?) \(base/.exec(l);
    if (m) {
      skills[m[1]] = Number(m[2]);
    }
  }
  return Object.keys(skills).length ? skills : undefined;
}

export type FightOutcome = "won" | "died" | "fled" | "lost" | "gave up" | "timeout";
export type FightResult = {
  outcome: FightOutcome;
  target: string;
  seconds: number;
  hits: number;
  maxHits: number;
  targetHealthPct: number;
  decisions: number;
  plans: Record<string, number>;
  latencyMs: number;
};

const hex = (serial: number) => `0x${serial.toString(16).toUpperCase().padStart(8, "0")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chebyshev = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null; // being replaced; the next tick reads it
  }
}

/** Navrey's log from an offset: whole lines without their time stamps, and the new offset. */
function logSince(offset: number): { lines: string[]; offset: number } {
  let size: number;
  try {
    size = statSync(FILES.log).size;
  } catch {
    return { lines: [], offset };
  }
  if (size <= offset) {
    return { lines: [], offset: Math.min(offset, size) };
  }
  const buf = Buffer.alloc(size - offset);
  const fd = openSync(FILES.log, "r");
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  const end = buf.lastIndexOf(0x0a) + 1;
  const lines = buf
    .subarray(0, end)
    .toString("utf8")
    .split("\n")
    .map((l) => l.replace(STAMP, "").trimEnd())
    .filter(Boolean);
  return { lines, offset: offset + end };
}

/** One command, and what Navrey printed for it up to its [CMD-END] (the way lab/uo_agent.py does it). */
export async function call(line: string, timeoutMs = 5_000): Promise<string[]> {
  let offset = statSync(FILES.log, { throwIfNoEntry: false })?.size ?? 0;
  appendFileSync(FILES.cmd, `${line}\n`);
  const marker = `[CMD-END] ${line} `;
  const seen: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = logSince(offset);
    offset = got.offset;
    for (const l of got.lines) {
      if (l.startsWith(marker)) {
        return seen;
      }
      if (l !== `[CMD] ${line}`) {
        seen.push(l);
      }
    }
    await sleep(20);
  }
  return [...seen, `(no answer to "${line}")`];
}

const sumOf = (items: NavreyItem[], graphic: number) => items.filter((i) => i.graphic === graphic).reduce((n, i) => n + i.amount, 0);
const firstOf = (items: NavreyItem[], graphic: number) => items.find((i) => i.graphic === graphic)?.serial ?? null;

/**
 * A fight against one creature until it dies, we die, we get away, it is lost from view, or time
 * runs out. Every decision is the brain's within the tactics; the tactics are the strategist's.
 */
export class NavreyFight {
  readonly #brain: DuelBrain;
  readonly #tactics: Tactics;
  readonly #target: number;
  readonly #record?: (row: object) => void;
  readonly #send: (line: string) => Promise<string[]>;
  #log = 0;
  #recent: string[] = [];
  #bandageEndsAt = 0;
  #potionReadyAt = 0;
  #lastGoto = { at: 0, x: -1, y: -1 };
  #lastSeen: NavreyMobile | null = null;
  #missingSince = 0;
  #outOfReachSince = 0;
  #retreating = false;
  /** The way out being tried (0 straight away, 1 and 2 at right angles) and where we stood when it began. */
  #flee = { at: 0, x: 0, y: 0, dir: 0 };
  /** Until when a cornered fighter fights back instead of trying to run (no way out a moment ago). */
  #corneredUntil = 0;
  /** When we last saw our target take damage: a target that vanishes just after a hit has died. */
  #hitAt = 0;
  /** Whether the target has been within our reach yet: the walk up to it is not a chase. */
  #met = false;
  /** Our skills, asked once when the fight starts: the question names them when any is below 100. */
  #skills: Record<string, number> | undefined;

  /** record: each decision, for training; send: a command to Navrey (tests stand in for it). */
  constructor(brain: DuelBrain, tactics: Tactics, target: number, opts: { record?: (row: object) => void; send?: (line: string) => Promise<string[]> } = {}) {
    this.#brain = brain;
    this.#tactics = tactics;
    this.#target = target;
    this.#record = opts.record;
    this.#send = opts.send ?? ((line) => call(line));
  }

  #note(text: string): void {
    this.#recent.push(text);
    if (this.#recent.length > 8) {
      this.#recent.shift();
    }
  }

  /** The game's own words since the last tick: damage both ways, a bandage finished. */
  #readLog(): void {
    const got = logSince(this.#log);
    this.#log = got.offset;
    for (const l of got.lines) {
      const hit = /^Damage: (.+) takes (\d+)/.exec(l);
      if (hit) {
        this.#note(`${hit[1]} took ${hit[2]} damage`);
        if (this.#lastSeen && hit[1] === this.#lastSeen.name) {
          this.#hitAt = Date.now();
        }
      } else if (/finish applying the bandages|stop applying the bandages|bandage has been interrupted/i.test(l)) {
        this.#bandageEndsAt = 0;
      }
    }
  }

  #weapon(s: NavreyState): WeaponView | null {
    const held = s.equipped.find((i) => (i.layer === "OneHanded" || i.layer === "TwoHanded") && WEAPONS[i.graphic]);
    const w = held ? WEAPONS[held.graphic] : null;
    if (!w) {
      return null;
    }
    // Skill totals are not in Navrey's state: abilities are costed at their base mana.
    return { name: w.name, ranged: w.ranged, range: w.range, primary: w.primary, primaryMana: abilityMana(w.primary, 0), secondary: w.secondary, secondaryMana: abilityMana(w.secondary, 0) };
  }

  #snapshot(s: NavreyState, them: NavreyMobile, now: number): DuelSnapshot {
    const pack = s.backpack ?? [];
    const supplies: Supplies = {
      bandages: sumOf(pack, GRAPHIC.bandage),
      healPotions: sumOf(pack, GRAPHIC.healPotion),
      curePotions: sumOf(pack, GRAPHIC.curePotion),
      refreshPotions: sumOf(pack, GRAPHIC.refreshPotion),
      explosionPotions: sumOf(pack, GRAPHIC.explosionPotion),
      arrows: sumOf(pack, GRAPHIC.arrow),
    };
    const weapon = this.#weapon(s);
    const distance = chebyshev({ x: s.charPosX, y: s.charPosY }, them);
    const reach = weapon?.range ?? 1;
    if (distance <= reach) {
      this.#outOfReachSince = 0;
    } else if (!this.#outOfReachSince) {
      this.#outOfReachSince = now;
    }
    const caster = CASTERS.test(`${them.species ?? ""} ${them.name}`);
    const beast = them.isHuman ? null : creatureFor(them.name, them.graphic);
    const k = this.#skills ?? {};
    const held = s.equipped.find((i) => (i.layer === "OneHanded" || i.layer === "TwoHanded") && WEAPONS[i.graphic]);
    const cost = beast
      ? danger(beast, {
          hits: Math.max(1, s.hits),
          weapon: k[weaponSkill(weapon)] ?? 50,
          tactics: k.Tactics ?? 50,
          anatomy: k.Anatomy ?? 50,
          parry: k.Parrying ?? 0,
          damage: 16,
          swing: held ? WEAPONS[held.graphic].mlSpeed : 3.75,
          armor: s.physicalResistance,
        })
      : null;
    return {
      now,
      us: {
        name: s.charName,
        serial: Number.parseInt(s.charID, 16),
        hits: s.hits,
        hitsMax: s.maxHits,
        mana: s.mana,
        manaMax: s.maxMana,
        stam: s.stamina,
        stamMax: s.maxStam,
        poisoned: s.isPoisoned,
        x: s.charPosX,
        y: s.charPosY,
        z: s.charPosZ,
        readyInMs: 0,
        lastSpell: null,
        lastSpellAgoMs: Number.POSITIVE_INFINITY,
        weapon,
        bandagingForMs: Math.max(0, this.#bandageEndsAt - now),
        mortalStrike: s.isYellowHits,
        healPotionReadyInMs: Math.max(0, this.#potionReadyAt - now),
        lastAbilityAgoMs: Number.POSITIVE_INFINITY,
        // A shield is held in the second hand (UO's TwoHanded layer): no potions with one.
        freeHand: !s.equipped.some((i) => i.layer === "TwoHanded"),
        outOfReachForMs: this.#outOfReachSince ? now - this.#outOfReachSince : 0,
        ...(this.#skills ? { skills: this.#skills } : {}),
      },
      them: {
        name: them.name,
        serial: this.#target,
        healthPct: them.maxHits > 0 ? Math.round((100 * them.hits) / them.maxHits) : 100,
        poisoned: false,
        x: them.x,
        y: them.y,
        z: them.z,
        dead: them.isDead,
        casting: null,
        castingForMs: 0,
        landsInMs: 0,
        distance,
        inLineOfSight: true,
        inRange: distance <= reach,
        weapon: caster ? null : "natural weapon",
        ...(beast && cost
          ? {
              creature: {
                danger: cost.level,
                loss: cost.loss,
                attacksOnSight: beast.fightMode === "Closest" || beast.fightMode === "Evil",
                caster: beast.ai === "mage",
              },
            }
          : {}),
      },
      supplies,
      reagents: {},
      tiles: [],
      recent: [...this.#recent],
    };
  }

  async #walkTo(x: number, y: number, now: number): Promise<void> {
    const moved = this.#lastGoto.x !== x || this.#lastGoto.y !== y;
    if (moved || now - this.#lastGoto.at > 1_500) {
      this.#lastGoto = { at: now, x, y };
      await this.#send(`goto ${x} ${y}`);
    }
  }

  /** The plan carried out with Navrey's commands. */
  async #act(plan: Plan, s: NavreyState, them: NavreyMobile, snap: DuelSnapshot, now: number): Promise<void> {
    const pack = s.backpack ?? [];
    switch (plan.kind) {
      case "attack":
      case "approach":
      case "throw": {
        // Weapon abilities and explosion potions are not in Navrey's commands yet: a plain attack.
        this.#retreating = false;
        if (s.lastAttack?.serial !== hex(this.#target) || !s.warMode) {
          await this.#send(`attack ${hex(this.#target)}`);
        }
        if (snap.them.distance > (snap.us.weapon?.range ?? 1)) {
          await this.#walkTo(them.x, them.y, now);
        }
        return;
      }
      case "bandage": {
        const bandage = firstOf(pack, GRAPHIC.bandage);
        if (!bandage) {
          return;
        }
        await this.#send(`use ${bandage}`);
        for (let i = 0; i < 6; i++) {
          const reply = (await this.#send("target self")).join(" ");
          if (!/nothing is asking for a target/i.test(reply)) {
            break;
          }
          await sleep(150);
        }
        this.#bandageEndsAt = now + selfBandageSeconds(s.dex) * 1000;
        this.#note(`${s.charName} began bandaging`);
        return;
      }
      case "drink": {
        const graphic = plan.potion === "heal" ? GRAPHIC.healPotion : plan.potion === "cure" ? GRAPHIC.curePotion : GRAPHIC.refreshPotion;
        const potion = firstOf(pack, graphic);
        if (potion) {
          await this.#send(`use ${potion}`);
          if (plan.potion === "heal") {
            this.#potionReadyAt = now + HEAL_POTION_DELAY_MS;
          }
          this.#note(`${s.charName} drank a ${plan.potion} potion`);
        }
        return;
      }
      case "retreat": {
        // Ten tiles further along the line from them to us; when that way is blocked (water, a cliff, a
        // wall) for over a second, at right angles to it; with no way out, fight back for 5 s rather than
        // stand still and take the hits (a cautious fighter died that way against a mongbat, 2026-10-15).
        if (now < this.#corneredUntil) {
          return this.#act({ kind: "attack" }, s, them, snap, now);
        }
        const here = { x: s.charPosX, y: s.charPosY };
        if (!this.#retreating || chebyshev(here, this.#flee) >= 1) {
          this.#flee = { at: now, x: here.x, y: here.y, dir: this.#retreating ? this.#flee.dir : 0 };
        } else if (now - this.#flee.at > 1_200) {
          this.#flee = { at: now, x: here.x, y: here.y, dir: this.#flee.dir + 1 };
          if (this.#flee.dir > 2) {
            this.#corneredUntil = now + 5_000;
            this.#flee.dir = 0;
            this.#note(`${s.charName} was cornered by ${them.name} and fought back`);
            this.#retreating = false;
            await this.#send("stop"); // the walk would keep trying the blocked way
            return this.#act({ kind: "attack" }, s, them, snap, now);
          }
        }
        const [ax, ay] = s.charPosX === them.x && s.charPosY === them.y ? [1, 0] : [s.charPosX - them.x, s.charPosY - them.y];
        const turn = [0, Math.PI / 2, -Math.PI / 2][this.#flee.dir];
        const dx = ax * Math.cos(turn) - ay * Math.sin(turn);
        const dy = ax * Math.sin(turn) + ay * Math.cos(turn);
        const len = Math.max(1, Math.hypot(dx, dy));
        if (!this.#retreating) {
          this.#note(`${s.charName} ran from ${them.name}`);
        }
        this.#retreating = true;
        await this.#walkTo(Math.round(s.charPosX + (10 * dx) / len), Math.round(s.charPosY + (10 * dy) / len), now);
        return;
      }
      case "cast":
      case "teleport":
      case "wait":
        return;
    }
  }

  async run(maxSeconds: number): Promise<FightResult> {
    const started = Date.now();
    this.#log = statSync(FILES.log, { throwIfNoEntry: false })?.size ?? 0;
    // Others' health reaches the client only for status bars it asked for.
    await this.#send(`hp ${hex(this.#target)}`);
    this.#skills = parseSkills(await this.#send("skills"));
    const plans: Record<string, number> = {};
    let decisions = 0;
    let latency = 0;
    let errors = 0;
    let outcome: FightOutcome = "timeout";
    let s = readJson<NavreyState>(FILES.state);
    let askedHp = Date.now();
    for (;;) {
      const now = Date.now();
      if (now - askedHp >= 3_000) {
        // The server sends their health on a status request, and not always after each hit.
        askedHp = now;
        await this.#send(`hp ${hex(this.#target)}`);
      }
      s = readJson<NavreyState>(FILES.state) ?? s;
      if (!s) {
        await sleep(TICK_MS);
        continue;
      }
      this.#readLog();
      if (s.charGhost) {
        outcome = "died";
        break;
      }
      const world = readJson<{ mobiles: NavreyMobile[]; containers?: { name: string; x: number; y: number }[] }>(FILES.world);
      const them = world?.mobiles.find((m) => Number.parseInt(m.serial, 16) === this.#target) ?? null;
      if (them && !them.isDead) {
        this.#lastSeen = them;
        this.#missingSince = 0;
      } else {
        // Gone: dead (its body is a corpse now), or out of view. A corpse where it stood, a hit just
        // before it vanished, or little health left: it died.
        this.#missingSince ||= now;
        const seen = this.#lastSeen;
        const pct = seen && seen.maxHits > 0 ? (100 * seen.hits) / seen.maxHits : 100;
        const kind = (seen?.name ?? "").replace(/^(a|an|the) /i, "").toLowerCase();
        const corpse = !!seen && (world?.containers ?? []).some((c) => /corpse/i.test(c.name) && c.name.toLowerCase().includes(kind) && chebyshev(c, seen) <= 3);
        if (them?.isDead || corpse || this.#missingSince - this.#hitAt < 3_000 || (now - this.#missingSince >= 1_500 && pct <= 30)) {
          outcome = "won";
          break;
        }
        if (now - this.#missingSince >= 4_000) {
          outcome = "lost";
          break;
        }
        await sleep(TICK_MS);
        continue;
      }
      if (this.#retreating && chebyshev({ x: s.charPosX, y: s.charPosY }, them) >= 12) {
        outcome = "fled";
        break;
      }
      if (now - started >= maxSeconds * 1000) {
        break;
      }
      const snap = this.#snapshot(s, them, now);
      const archetype = snap.them.weapon ? "melee" : "caster";
      // Out of reach for longer than the tactics chase (a creature in water, behind a wall): as the
      // arena's fighters do, give up the chase. Before the first contact the walk up to it gets its own time.
      const chase = tacticsFor(this.#tactics, archetype).chase;
      this.#met ||= snap.them.inRange;
      const away = snap.us.outOfReachForMs ?? 0;
      if (this.#met ? away > chase.giveUpSeconds * 1000 || snap.them.distance > chase.maxTiles : away > APPROACH_MS) {
        outcome = "gave up";
        break;
      }
      let decision: Decision;
      try {
        decision = await this.#brain.decide(snap, tacticsFor(this.#tactics, archetype));
        errors = 0;
      } catch (e) {
        if (++errors >= 5) {
          throw new Error(`the brain failed 5 times in a row: ${(e as Error).message}`);
        }
        await sleep(TICK_MS);
        continue;
      }
      decisions++;
      latency += decision.latencyMs;
      plans[decision.plan.kind] = (plans[decision.plan.kind] ?? 0) + 1;
      this.#record?.({
        t: now,
        target: { serial: hex(this.#target), name: them.name, species: them.species },
        us: { hits: snap.us.hits, hitsMax: snap.us.hitsMax, stam: snap.us.stam, poisoned: snap.us.poisoned, bandagingForMs: snap.us.bandagingForMs },
        them: { healthPct: snap.them.healthPct, distance: snap.them.distance },
        // The whole state and answer, so that the question can be asked again in any later format
        // (fights against monsters are training material the arena does not have).
        snapshot: snap,
        format: MELEE_FORMAT,
        plan: decision.plan,
        why: decision.why,
        mode: decision.mode,
        parts: decision.parts,
        overrides: decision.overrides,
        latencyMs: decision.latencyMs,
        model: decision.model,
        tactics: this.#tactics.id,
      });
      await this.#act(decision.plan, s, them, snap, now);
      await sleep(Math.max(0, TICK_MS - (Date.now() - now)));
    }
    const end = readJson<NavreyState>(FILES.state) ?? s;
    if (outcome !== "won") {
      await this.#send("stop"); // a pursuit or a retreat still walking
    }
    const last = this.#lastSeen;
    return {
      outcome,
      target: last?.name ?? hex(this.#target),
      seconds: Math.round((Date.now() - started) / 1000),
      hits: end?.hits ?? 0,
      maxHits: end?.maxHits ?? 0,
      targetHealthPct: outcome === "won" ? 0 : last && last.maxHits > 0 ? Math.round((100 * last.hits) / last.maxHits) : 100,
      decisions,
      plans,
      latencyMs: decisions ? Math.round(latency / decisions) : 0,
    };
  }
}

/** The fight's end in a sentence for the strategist. */
export function describeResult(r: FightResult): string {
  const plans = Object.entries(r.plans)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  const how = {
    won: `${r.target} is dead`,
    died: `you died fighting ${r.target}`,
    fled: `you got away from ${r.target} (it had ${r.targetHealthPct}% health)`,
    lost: `${r.target} went out of view with ${r.targetHealthPct}% health`,
    "gave up": `${r.target} stayed out of reach, so the chase was given up (it has ${r.targetHealthPct}% health)`,
    timeout: `the fight went on too long; ${r.target} has ${r.targetHealthPct}% health`,
  }[r.outcome];
  return `${r.outcome}: ${how} after ${r.seconds} s. Your hits: ${r.hits}/${r.maxHits}. Laya made ${r.decisions} decisions (${plans || "none"}), ${r.latencyMs} ms each.`;
}
