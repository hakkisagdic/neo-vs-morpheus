// Rehber in the game: a GameMaster of its own (account "rehber") that says a scene's lines overhead
// and does what it explains, on the real map (lab/world.sh's server). Scenes are data (scenes.ts).
//
// Safety: an agent session (lab/uo_agent.py) owns the arena while it runs. The guide never goes near
// it then, never says an arena command then, and cleans up every creature it added (by serial, as it
// remembers them; a GameMaster cannot use [Global).
import { spawnSync } from "node:child_process";
import { config } from "../config.ts";
import { GRAPHIC, packCount, useItem } from "../game/items.ts";
import { Mover, chebyshev, directionTo } from "../game/mover.ts";
import { Session } from "../game/session.ts";
import * as out from "../uo/outgoing.ts";
import type { BuyList, Gump, JournalEntry, TargetCursor } from "../world/world.ts";
import {
  GUIDE,
  MAPS,
  type Place,
  type Scene,
  type Step,
  type Target,
  addCommand,
  fillPlaceholders,
  goCommands,
  isArenaCommand,
  moongateFirstFacet,
  moongateSwitch,
  nearArena,
} from "./scenes.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const hex = (serial: number) => `0x${serial.toString(16).toUpperCase().padStart(8, "0")}`;

/**
 * Where the guide plays: always the world server on the real map (lab/world.sh), whatever UO_PORT says
 * (the bots' arena); its scenes happen in New Haven, which only the real map has.
 */
export const WORLD = { host: config.worldHost, port: config.worldPort };

/**
 * The guide logged in, as a Mondain's Legacy client: it claims the facets, so that a public moongate
 * offers Trammel's gates (claiming none, it is offered Felucca's alone).
 */
export const guideSession = (log?: (message: string) => void): Promise<Session> =>
  Session.bot(GUIDE, log, { ...WORLD, clientFlags: out.FACETS_ML });

/** Whether an agent session plays now (lab/uo_agent.py): while one runs, the arena is its. */
export function agentSessionRunning(): boolean {
  return spawnSync("pgrep", ["-f", "lab/uo_agent.py"]).status === 0;
}

/**
 * Notoriety the server shows staff with, to everyone and to themselves (Notoriety.MobileNotoriety):
 * gray, or invulnerable when blessed ([ResetStaffDress blesses). A new character is innocent (1).
 */
const STAFF_NOTORIETY = new Set([3, 7]);
/** A public moongate (PublicMoongate's item id). */
const MOONGATE = 0x0f6c;
/** Bandage messages that end an application: finished, barely helped, little damage, slipped, died, too far. */
const BANDAGE_DONE = new Set([500969, 500968, 1010395, 500961, 500962, 500963]);
/** A mobile's hidden flag in 0x20/0x77/0x78. */
const HIDDEN = 0x80;
/**
 * The texts of localized messages the scenes bring, for the log (without the client's cliloc files
 * the server sends numbers): as ModernUO's source comments give them.
 */
const SAID: Record<number, string> = {
  500186: "Greetings.  Have a look around.",
  500948: "Who will you use the bandages on?",
  500956: "You begin applying the bandages.",
  500968: "You apply the bandages, but they barely help.",
  500969: "You finish applying the bandages.",
  1019039: "You are no longer considered a young player of Ultima Online.",
  1019051: "You have gained a little fame.",
  1019059: "You have gained a little karma.",
  1019063: "You have lost a little karma.",
  1042759: "Thy current bank balance is ~1_AMOUNT~ gold.",
};

/** A journal line's text: a known cliloc's sentence with its arguments filled in, else what came. */
export function journalText(text: string, cliloc?: number): string {
  const sentence = cliloc ? SAID[cliloc] : undefined;
  if (!sentence) {
    return text.replaceAll("\t", " ").trim() || (cliloc ? `cliloc ${cliloc}` : "");
  }
  const args = text.split("\t");
  let i = 0;
  return sentence.replace(/~\d+_[A-Z_]+~/g, () => args[i++] ?? "");
}

type Added = { serial: number; type: string; x: number; y: number; dead: boolean; corpse?: number };

export class Director {
  readonly session: Session;
  readonly places: Record<string, Place>;
  readonly log: (line: string) => void;
  readonly sessionRunning: () => boolean;
  mover: Mover;
  readonly #added = new Map<string, Added>();
  readonly #t0 = Date.now();
  #lastHeard = 0;

  constructor(session: Session, places: Record<string, Place>, log: (line: string) => void = console.log, sessionRunning = agentSessionRunning) {
    this.session = session;
    this.places = places;
    this.log = log;
    this.sessionRunning = sessionRunning;
    this.mover = new Mover(session);
    session.world.on("journal", (e) => this.#heard(e));
    // 0xAF, a death: the creature and the corpse it leaves, which goes at the cleanup too.
    session.client.on("packet", (id, data) => {
      if (id === 0xaf && data.length >= 9) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        this.#died(view.getUint32(1), view.getUint32(5));
      }
    });
    session.world.on("death", (serial) => this.#died(serial));
  }

  #stamp(): string {
    const s = (Date.now() - this.#t0) / 1000;
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
  }

  #note(text: string): void {
    this.log(`[${this.#stamp()}] ${text}`);
  }

  /** Everything the guide hears: its own lines echoed overhead, the server's answers, what others say. */
  #heard(e: JournalEntry): void {
    this.#lastHeard = Date.now();
    const who = e.serial === this.session.world.playerSerial ? GUIDE : e.name || "sistem";
    this.log(`[${this.#stamp()}]   ${who}: ${journalText(e.text, e.cliloc)}${e.cliloc ? ` [${e.cliloc}]` : ""}`);
  }

  #died(serial: number, corpse?: number): void {
    for (const [as, a] of this.#added) {
      if (a.serial !== serial) {
        continue;
      }
      if (!a.dead) {
        a.dead = true;
        this.#note(`${as} died`);
      }
      if (corpse && !a.corpse) {
        a.corpse = corpse;
        this.#note(`  ${as}'s body: ${hex(corpse)}`);
      }
    }
  }

  /** Polls until `test` gives a value (or true), at most `ms`. */
  async #until<T>(test: () => T | undefined | false, ms: number): Promise<T | undefined> {
    const end = Date.now() + ms;
    for (;;) {
      const v = test();
      if (v !== undefined && v !== false) {
        return v;
      }
      if (Date.now() >= end) {
        return undefined;
      }
      await sleep(50);
    }
  }

  /** Waits for the server's answer: until it has been quiet for 400 ms after one, at most `seconds`. */
  async #settle(since: number, seconds: number): Promise<void> {
    await this.#until(() => this.#lastHeard > since && Date.now() - this.#lastHeard >= 400, seconds * 1000);
  }

  #next<T>(event: "target" | "gump" | "buyList", ms: number): Promise<T | null> {
    const { world } = this.session;
    return new Promise((resolve) => {
      const on = (v: T) => {
        clearTimeout(timer);
        world.off(event, on as never);
        resolve(v);
      };
      const timer = setTimeout(() => {
        world.off(event, on as never);
        resolve(null);
      }, ms);
      world.on(event, on as never);
    });
  }

  #creature(as: string): Added {
    const a = this.#added.get(as);
    if (!a) {
      throw new Error(`no creature called ${as} in this scene`);
    }
    return a;
  }

  /** Plays a scene from its start place to its end, then removes whatever it added, come what may. */
  async play(scene: Scene): Promise<void> {
    if (scene.needs === "no-session" && this.sessionRunning()) {
      throw new Error(`${scene.id}: an agent session is running (lab/uo_agent.py), and this scene acts at the arena`);
    }
    this.#note(`== ${scene.id}: ${scene.title}`);
    try {
      await this.#go(scene.start);
      for (const step of scene.steps) {
        await this.#step(step);
      }
    } finally {
      await this.#cleanup();
    }
    this.#note(`== ${scene.id} done`);
  }

  async #step(step: Step): Promise<void> {
    switch (step.kind) {
      case "say":
        this.session.say(step.text);
        return sleep(step.seconds * 1000);
      case "gm":
        return this.#gm(step.command, step.target, step.seconds, step.confirm);
      case "go":
        return this.#go(step.place);
      case "walk": {
        const me = this.session.world.player;
        const from = `${me.x},${me.y}`;
        const there = await this.#walkTo({ x: me.x + step.dx, y: me.y + step.dy }, step.run);
        this.#note(`${step.run ? "ran" : "walked"} ${from} -> ${me.x},${me.y}${there ? "" : " (the way was blocked)"}`);
        return;
      }
      case "wait":
        return sleep(step.seconds * 1000);
      case "add":
        return this.#add(step);
      case "war":
        return this.#war(step.on);
      case "attack":
        return this.#attack(step.as, step.seconds);
      case "bandage":
        return this.#bandage(step.seconds);
      case "speak":
        return this.#speak(step.keyword);
      case "buy":
        return this.#buy(step);
      case "moongate":
        return this.#moongate(step.to);
      case "cleanup":
        return this.#cleanup();
    }
  }

  /**
   * Says a GM command; answers its target cursor when the step names a target, cancels one otherwise.
   * A gump it opens is closed afterwards ([Props), or, with `confirm`, answered OKAY (the server's
   * question before deleting several objects).
   */
  async #gm(command: string, target: Target | undefined, seconds: number, confirm = false): Promise<void> {
    const { client, world } = this.session;
    const text = fillPlaceholders(command, new Map([...this.#added].map(([as, a]) => [as, a.serial])));
    if (isArenaCommand(text) && this.sessionRunning()) {
      throw new Error(`${text}: an agent session is running, and the arena is its`);
    }
    const onTarget = (c: TargetCursor) => {
      if (target) {
        this.#answer(c, target);
      } else {
        client.send(out.cancelTarget(c.id));
        world.target = null;
      }
    };
    const opened: Gump[] = [];
    const onGump = (g: Gump) => opened.push(g);
    world.on("target", onTarget);
    world.on("gump", onGump);
    const said = Date.now();
    const me = world.player;
    const from = { x: me.x, y: me.y };
    this.#note(`gm ${text}`);
    this.session.say(text);
    try {
      await this.#settle(said, seconds);
    } finally {
      world.off("target", onTarget);
      world.off("gump", onGump);
    }
    if (chebyshev(me, from) > 0) {
      this.#note(`  moved ${from.x},${from.y} -> ${me.x},${me.y}`);
      this.mover = new Mover(this.session);
    }
    for (const g of opened) {
      const okay = confirm && g === opened[opened.length - 1];
      this.#note(`  gump ${g.typeId} ${okay ? "answered OKAY" : "closed"}`);
      client.send(out.gumpResponse(g.serial, g.typeId, okay ? 1 : 0));
      world.gumps.delete(g.serial);
      if (okay) {
        await this.#settle(Date.now(), 2);
      }
    }
    if (/\sdelete\b/i.test(text)) {
      // A scene that deletes its own creatures leaves the cleanup less to do: those gone from sight
      // while close enough to be seen were deleted, not walked out of view.
      for (const [as, a] of this.#added) {
        if (!a.dead && !world.mobiles.has(a.serial) && chebyshev(me, a) <= 15) {
          this.#added.delete(as);
        }
      }
    }
  }

  #answer(c: TargetCursor, target: Target): void {
    const { client, world } = this.session;
    const me = world.player;
    if (target.kind === "self") {
      client.send(out.targetObject(c.id, c.flags, me.serial, me.x, me.y, me.z, me.body));
    } else if (target.kind === "creature") {
      const a = this.#creature(target.as);
      const m = world.mobiles.get(a.serial);
      client.send(out.targetObject(c.id, c.flags, a.serial, m?.x ?? a.x, m?.y ?? a.y, m?.z ?? me.z, m?.body ?? 0));
    } else {
      client.send(out.targetLocation(c.id, c.flags, me.x + target.dx, me.y + target.dy, me.z));
    }
    world.target = null;
    this.#note(`  target: ${target.kind === "creature" ? target.as : target.kind === "self" ? GUIDE : `${me.x + target.dx},${me.y + target.dy}`}`);
  }

  /** To a place: on foot when it is close on this facet, else [Go (and [Go <facet> first when elsewhere). */
  async #go(name: string): Promise<void> {
    const p = this.places[name];
    if (!p) {
      throw new Error(`no place ${name}`);
    }
    if (nearArena(p) && this.sessionRunning()) {
      throw new Error(`${name} is at the arena, and an agent session is running`);
    }
    const { world } = this.session;
    const me = world.player;
    const facet = MAPS.indexOf(p.map);
    if (world.map === facet && chebyshev(me, p) <= 1) {
      return;
    }
    if (world.map === facet && chebyshev(me, p) <= 10) {
      const from = `${me.x},${me.y}`;
      const there = await this.#walkTo(p, false);
      this.#note(`walked to ${name}: ${from} -> ${me.x},${me.y}${there ? "" : " (blocked; teleports instead)"}`);
      if (there) {
        return;
      }
    }
    for (const command of goCommands(p, world.map)) {
      this.#note(`gm ${command}`);
      this.session.say(command);
      const arrived = command.startsWith(`[Go ${p.map}`)
        ? await this.#until(() => world.map === facet, 3000)
        : await this.#until(() => chebyshev(me, p) <= 1, 3000);
      if (!arrived) {
        throw new Error(`${command}: still at ${me.x},${me.y} on ${MAPS[world.map] ?? "?"} (is ${GUIDE} a GameMaster? npm run nvm -- rehber setup)`);
      }
    }
    this.#note(`at ${name}: ${me.x},${me.y},${me.z} ${MAPS[world.map]}`);
    this.mover = new Mover(this.session); // a teleport restarts the server's step sequence
    await sleep(500);
  }

  /** Step by step to a tile, walking or running, until there or the way is refused four times. */
  async #walkTo(to: { x: number; y: number }, run: boolean): Promise<boolean> {
    const me = this.session.world.player;
    let refused = 0;
    for (let tries = 0; chebyshev(me, to) > 0 && tries < 80 && refused < 4; tries++) {
      const direction = directionTo(me, to);
      const facing = me.direction === direction;
      if (!(await this.mover.step(direction, run))) {
        refused++;
        await sleep(300);
        continue;
      }
      if (facing) {
        await sleep(run ? 210 : 410);
      }
    }
    return chebyshev(me, to) === 0;
  }

  /** [Add with the target cursor answered beside the guide; the new creature is remembered by serial. */
  async #add(step: Extract<Step, { kind: "add" }>): Promise<void> {
    const { client, world } = this.session;
    const me = world.player;
    const at = { x: me.x + step.dx, y: me.y + step.dy };
    const known = new Set(world.mobiles.keys());
    const command = addCommand(step.type, step.set);
    const cursor = this.#next<TargetCursor>("target", 4000);
    this.#note(`gm ${command}`);
    this.session.say(command);
    const c = await cursor;
    if (!c) {
      throw new Error(`${command}: no target cursor came (is ${GUIDE} a GameMaster? npm run nvm -- rehber setup)`);
    }
    client.send(out.targetLocation(c.id, c.flags, at.x, at.y, me.z));
    world.target = null;
    const serial = await this.#until(() => {
      for (const m of world.mobiles.values()) {
        if (!known.has(m.serial) && m.serial !== world.playerSerial && chebyshev(m, at) <= 1) {
          return m.serial;
        }
      }
      return undefined;
    }, 3000);
    if (serial === undefined) {
      throw new Error(`${command}: no creature appeared at ${at.x},${at.y}`);
    }
    this.#added.set(step.as, { serial, type: step.type, x: at.x, y: at.y, dead: false });
    this.#note(`  + ${step.as}: ${step.type} ${hex(serial)} at ${at.x},${at.y}`);
    client.send(out.singleClick(serial)); // its name overhead, for the log
    await sleep(300);
  }

  async #war(on: boolean): Promise<void> {
    const { client, world } = this.session;
    client.send(out.warMode(on));
    const ok = await this.#until(() => world.warMode === on, 1500);
    this.#note(`${on ? "war" : "peace"} mode${ok ? "" : " (not confirmed)"}`);
  }

  /** Attacks a creature of the scene and stays at it until it dies or the time is up. */
  async #attack(as: string, seconds: number): Promise<void> {
    const { client, world } = this.session;
    const a = this.#creature(as);
    if (!world.warMode) {
      await this.#war(true);
    }
    this.#note(`attacks ${as} ${hex(a.serial)}`);
    client.send(out.attack(a.serial));
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end && !a.dead) {
      const m = world.mobiles.get(a.serial);
      if (!m) {
        break;
      }
      if (chebyshev(world.player, m) > 1) {
        await this.mover.step(directionTo(world.player, m), true);
      }
      await sleep(250);
    }
    if (!a.dead) {
      this.#note(world.mobiles.has(a.serial) ? `${as} still stands after ${seconds} s` : `${as} is gone`);
    }
  }

  /** A bandage on the guide itself; waits for the application to end. */
  async #bandage(seconds: number): Promise<void> {
    const { client, world } = this.session;
    if (world.backpack) {
      client.send(out.doubleClick(world.backpack)); // the pack's contents, fresh
      await sleep(700);
    }
    const me = world.player;
    const before = me.hits;
    let ended = false;
    const onJournal = (e: JournalEntry) => {
      ended ||= BANDAGE_DONE.has(e.cliloc ?? 0);
    };
    world.on("journal", onJournal);
    try {
      const r = await useItem(this.session, GRAPHIC.bandage, { kind: "self" });
      this.#note(`bandage on ${GUIDE}: ${r}, ${packCount(this.session, GRAPHIC.bandage)} left, health ${before}/${me.hitsMax}`);
      if (r === "used") {
        await this.#until(() => ended, seconds * 1000);
        await sleep(300);
        this.#note(`health ${before} -> ${me.hits}/${me.hitsMax}`);
      }
    } finally {
      world.off("journal", onJournal);
    }
  }

  /** Says a keyword as a player would type it ("bank"); for the bank, waits for the box to open. */
  async #speak(keyword: out.Keyword): Promise<void> {
    const { client, world } = this.session;
    const said = Date.now();
    let opened: [number, number] | null = null;
    const onContainer = (serial: number, gump: number) => {
      opened ??= [serial, gump];
    };
    world.on("container", onContainer);
    this.#note(`says "${keyword}" (keyword 0x${out.KEYWORDS[keyword].toString(16)})`);
    client.send(out.keywordSpeech(keyword, [out.KEYWORDS[keyword]]));
    try {
      await this.#settle(said, 3);
      if (keyword === "bank") {
        await this.#until(() => opened, 1500);
        const box = opened as [number, number] | null;
        this.#note(box ? `a container opened: ${hex(box[0])}, gump 0x${box[1].toString(16)}` : "no container opened");
      }
    } finally {
      world.off("container", onContainer);
    }
  }

  /** Finds the vendor by its title, stands at it, says "vendor buy" and buys from the window it opens. */
  async #buy(step: Extract<Step, { kind: "buy" }>): Promise<void> {
    const { client, world } = this.session;
    const me = world.player;
    const near = [...world.mobiles.values()].filter((m) => m.serial !== me.serial && !m.dead && chebyshev(me, m) <= 12);
    const labels = new Map<number, string>();
    const onLabel = (e: JournalEntry) => {
      if (near.some((m) => m.serial === e.serial)) {
        labels.set(e.serial, `${labels.get(e.serial) ?? ""} ${e.text.replaceAll("\t", " ")}`.trim());
      }
    };
    world.on("journal", onLabel);
    for (const m of near) {
      client.send(out.singleClick(m.serial));
      await sleep(40);
    }
    await sleep(1200);
    world.off("journal", onLabel);
    // The title exactly: "the healer guildmaster" is no healer to buy from (guildmasters sell nothing).
    const title = new RegExp(`\\bthe ${step.vendor}$`, "i");
    const vendor = near
      .filter((m) => title.test(labels.get(m.serial) ?? ""))
      .sort((a, b) => chebyshev(me, a) - chebyshev(me, b))[0];
    if (!vendor) {
      throw new Error(`no ${step.vendor} near ${me.x},${me.y}; heard: ${[...labels.values()].join(", ") || "nobody"}`);
    }
    this.#note(`the ${step.vendor}: ${labels.get(vendor.serial)} ${hex(vendor.serial)} at ${vendor.x},${vendor.y}`);
    if (chebyshev(me, vendor) > 1) {
      // Under AOS rules a vendor answers "vendor buy" from one tile away at most (VendorAI).
      this.#note(`gm [Go ${hex(vendor.serial)}`);
      this.session.say(`[Go ${hex(vendor.serial)}`);
      await this.#until(() => chebyshev(me, vendor) <= 1, 3000);
      this.mover = new Mover(this.session);
    }
    const window = this.#next<BuyList>("buyList", 3000);
    this.#note(`says "vendor buy" (keyword 0x${out.KEYWORDS["vendor buy"].toString(16)})`);
    client.send(out.keywordSpeech("vendor buy", [out.KEYWORDS["vendor buy"]]));
    const list = await window;
    if (!list) {
      throw new Error(`${hex(vendor.serial)} opened no buy window`);
    }
    await sleep(300);
    const offered = [...world.items.values()].filter((i) => i.container === list.container);
    this.#note(`buy window: ${list.entries.length} goods, ${list.entries.slice(0, 6).map((e) => `${e.name} ${e.price}gp`).join(", ")}${list.entries.length > 6 ? ", ..." : ""}`);
    const item = offered.find((i) => i.graphic === step.graphic);
    if (!item) {
      const graphics = offered.map((i) => `0x${i.graphic.toString(16)}`).join(" ");
      throw new Error(`the ${step.vendor} sells no ${step.item} (graphic 0x${step.graphic.toString(16)}) here; it offers ${graphics || "nothing"}`);
    }
    const before = packCount(this.session, step.graphic);
    const said = Date.now();
    client.send(out.vendorBuy(vendor.serial, [{ serial: item.serial, amount: step.amount }]));
    await this.#until(() => packCount(this.session, step.graphic) > before, 3000);
    await this.#settle(said, 2);
    this.#note(`${step.item} in the pack: ${before} -> ${packCount(this.session, step.graphic)}`);
  }

  /** Steps onto the moongate nearby and picks the destination in its gump; unhides on arrival. */
  async #moongate(to: string): Promise<void> {
    const { client, world } = this.session;
    const me = world.player;
    let gate: { serial: number; x: number; y: number } | null = null;
    for (const item of world.items.values()) {
      if (item.graphic === MOONGATE && item.container === 0 && item.x !== undefined && item.y !== undefined &&
        chebyshev(me, { x: item.x, y: item.y }) <= 10 && (!gate || chebyshev(me, { x: item.x, y: item.y }) < chebyshev(me, gate))) {
        gate = { serial: item.serial, x: item.x, y: item.y };
      }
    }
    if (!gate) {
      throw new Error(`no moongate within 10 tiles of ${me.x},${me.y}`);
    }
    const facet = MAPS[world.map];
    const choice = facet ? moongateSwitch(facet, to) : null;
    if (choice === null) {
      throw new Error(`the moongates of ${facet ?? "this facet"} do not list ${to}`);
    }
    this.#note(`walks onto the moongate ${hex(gate.serial)} at ${gate.x},${gate.y}`);
    let shown = this.#next<Gump>("gump", 6000);
    await this.#walkTo(gate, false);
    let g = await shown;
    if (!g) {
      shown = this.#next<Gump>("gump", 3000);
      client.send(out.doubleClick(gate.serial));
      g = await shown;
    }
    if (!g) {
      throw new Error("the moongate showed no destinations");
    }
    // The switch counts on this facet's gates coming first; never travel on a guess.
    const first = moongateFirstFacet(g.layout);
    if (g.layout && first !== facet) {
      client.send(out.gumpResponse(g.serial, g.typeId, 0));
      world.gumps.delete(g.serial);
      throw new Error(`the moongate lists ${first ?? "unknown"} gates first, not ${facet}'s; the guide stays`);
    }
    this.#note(`gump ${g.typeId}${g.layout.includes("1012011") ? ' "Pick your destination:"' : ""}, ${facet}'s gates first: ${to} (switch ${choice})`);
    const from = { x: me.x, y: me.y, map: world.map };
    client.send(out.gumpResponse(g.serial, g.typeId, 1, [choice]));
    world.gumps.delete(g.serial);
    const moved = await this.#until(() => world.map !== from.map || chebyshev(me, from) > 20, 4000);
    this.#note(moved ? `through the gate: ${me.x},${me.y},${me.z} ${MAPS[world.map]}` : "the gate did not take the guide anywhere");
    this.mover = new Mover(this.session);
    await sleep(600);
    // The gate hides whoever comes through, and staff stay hidden until unhidden (Mobile.RevealingAction).
    if (moved && me.flags & HIDDEN) {
      await this.#gm("[Self Unhide", undefined, 1.5);
    }
  }

  /** Deletes every creature (and body) the scene added, by serial; counts what is left where they stood. */
  async #cleanup(): Promise<void> {
    if (!this.#added.size) {
      return;
    }
    const { world } = this.session;
    const added = [...this.#added.entries()];
    this.#added.clear();
    const left: string[] = [];
    for (const [as, a] of added) {
      // A dead creature is gone already; its body is not.
      for (const serial of [a.dead ? 0 : a.serial, a.corpse ?? 0].filter((s) => s !== 0)) {
        try {
          await this.#gm(`[Serial ${hex(serial)} Delete`, undefined, 2);
        } catch (err) {
          left.push(`${as} ${hex(serial)} (${(err as Error).message})`);
        }
      }
    }
    if (left.length) {
      this.#note(`warning: not deleted: ${left.join("; ")}; a GameMaster can: [Serial <serial> Delete`);
      return;
    }
    // Proof where it can be seen: none of the scene's creatures (they all carry CantWalk) stands nearby.
    const me = world.player;
    for (const type of new Set(added.filter(([, a]) => chebyshev(me, a) <= 10).map(([, a]) => a.type))) {
      await this.#gm(`[Range 12 Count where ${type} CantWalk = true`, undefined, 2);
    }
  }
}

/**
 * Makes the guide: its character (on the first login of account "rehber"), GameMaster rights from the
 * owner (once: the access level is saved with the character), proved by a fresh login, and a GM's robe.
 */
export async function setupGuide(log: (line: string) => void = console.log): Promise<void> {
  const where = async (s: Session): Promise<string | null> => {
    let answer: string | null = null;
    const on = (e: { text: string }) => {
      answer ??= e.text.startsWith("You are at") ? e.text : null;
    };
    s.world.on("journal", on);
    s.say("[Where");
    for (let i = 0; i < 60 && !answer; i++) {
      await sleep(50);
    }
    s.world.off("journal", on);
    return answer;
  };
  const login = async () => {
    const s = await guideSession();
    await sleep(1500);
    const p = s.world.player;
    log(`${GUIDE}: ${s.login?.created ? "created" : "logged in"}, ${hex(p.serial)} at ${p.x},${p.y},${p.z} ${MAPS[s.world.map] ?? "?"}, notoriety ${p.notoriety}`);
    return s;
  };

  // A Blessed mobile cannot harm anything (Mobile.CanBeHarmful), and [ResetStaffDress blesses: the guide
  // fights in its scenes, and creatures never pick staff as targets anyway (BaseAI.IsInvalidTarget).
  const unbless = async (s: Session) => {
    s.say("[Self Set Blessed false");
    await sleep(1000);
  };

  let s = await login();
  // Staff look like staff even to themselves; a player saying "[Where" would only say it aloud.
  if (STAFF_NOTORIETY.has(s.world.player.notoriety)) {
    const answer = await where(s);
    if (answer) {
      log(`${GUIDE} is a GameMaster already: ${answer}`);
      s.world.on("journal", (e) => log(`  ${GUIDE} hears: ${e.text}`));
      await unbless(s);
      s.close();
      return;
    }
  }
  s.close();

  log(`the owner makes ${GUIDE} a GameMaster`);
  const owner = await Session.gm(undefined, WORLD);
  owner.world.on("journal", (e) => log(`  owner hears: ${e.text}`));
  owner.say(`[Global Set AccessLevel GameMaster where PlayerMobile Name = ${GUIDE}`);
  await sleep(2500);
  owner.close();

  s = await login();
  const answer = await where(s);
  if (!answer) {
    s.close();
    throw new Error(`${GUIDE} is still no GameMaster after the owner's [Global Set`);
  }
  log(`after a fresh login, ${GUIDE} answers [Where: ${answer}`);
  s.world.on("journal", (e) => log(`  ${GUIDE} hears: ${e.text}`));
  s.say("[ResetStaffDress"); // the GM's robe and body: a guide that looks like one
  await sleep(1500);
  await unbless(s);
  s.close();
}
