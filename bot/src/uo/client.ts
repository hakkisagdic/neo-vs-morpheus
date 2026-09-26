// A headless Ultima Online client: login flow, packet framing, keep-alive.
// Game logic lives elsewhere; this class only moves packets.
import { EventEmitter } from "node:events";
import net from "node:net";
import { HuffmanDecoder } from "./huffman.ts";
import { PacketReader } from "./io.ts";
import * as out from "./outgoing.ts";
import { packetLength } from "./packet-lengths.ts";

export type LoginOptions = {
  host: string;
  port: number;
  account: string;
  password: string;
  character: string;
  clientVersion: string;
  /** Used when the account has no character with this name yet. */
  newCharacter?: Omit<out.NewCharacter, "name" | "slot" | "cityIndex">;
  timeoutMs?: number;
};

export type LoginResult = {
  serial: number;
  created: boolean;
  body: number;
  x: number;
  y: number;
  z: number;
  direction: number;
};

type ClientEvents = {
  packet: [id: number, data: Uint8Array];
  close: [reason: string];
};

const LOGIN_REJECTIONS: Record<number, string> = {
  0: "invalid account or password",
  1: "account already in use",
  2: "account blocked",
  3: "bad password",
  4: "communication problem",
  5: "IGR concurrency limit",
  6: "IGR time limit",
  7: "IGR general error",
  8: "client version rejected",
};

export class UoClient extends EventEmitter<ClientEvents> {
  #socket: net.Socket | null = null;
  #decoder: HuffmanDecoder | null = null;
  #pending: Uint8Array = new Uint8Array(0);
  #pingTimer: NodeJS.Timeout | null = null;
  #pingSeq = 0;
  #closed = false;
  readonly log: (message: string) => void;

  constructor(log: (message: string) => void = () => {}) {
    super();
    this.log = log;
  }

  get connected(): boolean {
    return this.#socket !== null && !this.#closed;
  }

  send(packet: Uint8Array): void {
    if (!this.#socket || this.#closed) {
      throw new Error("not connected");
    }
    this.#socket.write(packet);
  }

  close(reason = "closed by client"): void {
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    if (this.#socket && !this.#closed) {
      this.#closed = true;
      this.#socket.destroy();
      this.emit("close", reason);
    }
  }

  /** Runs the whole login: account, server select, relay, game login, character. */
  async login(o: LoginOptions): Promise<LoginResult> {
    const timeout = o.timeoutMs ?? 15_000;
    const version = out.parseClientVersion(o.clientVersion);

    // 1. Login server: seed + account, answered by the server list or a rejection.
    await this.#connect(o.host, o.port, false);
    this.send(out.loginSeed(0x7f000001, version));
    this.send(out.accountLogin(o.account, o.password));
    const list = await this.#expect([0xa8, 0x82], timeout);
    if (list.id === 0x82) {
      throw new Error(`login rejected: ${LOGIN_REJECTIONS[list.data[1]] ?? `reason ${list.data[1]}`}`);
    }

    // 2. Pick the first server; the relay packet names the game server and a one-time key.
    this.send(out.selectServer(0));
    const relay = await this.#expect([0x8c, 0x82], timeout);
    if (relay.id === 0x82) {
      throw new Error(`server select rejected: ${LOGIN_REJECTIONS[relay.data[1]] ?? relay.data[1]}`);
    }
    const r = new PacketReader(relay.data, 5);
    const gamePort = r.u16();
    const authKey = r.u32();
    this.#disconnectQuietly();

    // 3. Game server. The relay's address is where the server thinks it lives, which is wrong
    //    behind Docker or NAT; the host we logged in through is the one that works.
    await this.#connect(o.host, gamePort, true);
    this.send(relay.data.subarray(7, 11)); // the key again, as this connection's seed
    this.send(out.gameLogin(authKey, o.account, o.password));

    const chars = await this.#expect([0xa9, 0x82], timeout);
    if (chars.id === 0x82) {
      throw new Error(`game login rejected: ${LOGIN_REJECTIONS[chars.data[1]] ?? chars.data[1]}`);
    }
    const { names, cityCount } = parseCharacterList(chars.data);

    // 4. Play the character, or create it in the first free slot.
    const slot = names.findIndex((n) => n.toLowerCase() === o.character.toLowerCase());
    let created = false;
    if (slot >= 0) {
      this.send(out.playCharacter(names[slot], slot));
    } else {
      if (!o.newCharacter) {
        throw new Error(`no character named ${o.character} on account ${o.account}`);
      }
      const free = names.findIndex((n) => n === "");
      if (free < 0 || cityCount === 0) {
        throw new Error(`account ${o.account} has no free character slot`);
      }
      this.send(out.createCharacter({ ...o.newCharacter, name: o.character, slot: free, cityIndex: 0 }));
      created = true;
    }

    // 5. The server asks for our version, confirms the login (0x1B), then signals completion (0x55).
    //    Both waits start now: 0x55 can arrive in the same read as 0x1B, before an await resumes.
    const onVersionRequest = (id: number) => {
      if (id === 0xbd) {
        this.send(out.clientVersionReply(o.clientVersion));
      }
    };
    this.on("packet", onVersionRequest);
    const confirmed = this.#expect([0x1b, 0x53, 0x85, 0x82], timeout);
    const completed = this.#expect([0x55], timeout);
    completed.catch(() => {}); // reported through `confirmed` when the login fails early
    try {
      const confirm = await confirmed;
      if (confirm.id !== 0x1b) {
        throw new Error(`character login failed (packet 0x${confirm.id.toString(16)}, code ${confirm.data[1]})`);
      }
      const c = new PacketReader(confirm.data, 1);
      const serial = c.u32();
      c.skip(4);
      const body = c.u16();
      const x = c.u16();
      const y = c.u16();
      const z = c.i16();
      const direction = c.u8();
      await completed;
      this.#startPing();
      return { serial, created, body, x, y, z, direction };
    } finally {
      this.off("packet", onVersionRequest);
    }
  }

  #startPing(): void {
    this.#pingTimer = setInterval(() => {
      if (this.connected) {
        this.send(out.ping(this.#pingSeq++ & 0xff));
      }
    }, 30_000);
    this.#pingTimer.unref();
  }

  #expect(ids: number[], timeoutMs: number): Promise<{ id: number; data: Uint8Array }> {
    return new Promise((resolve, reject) => {
      const onPacket = (id: number, data: Uint8Array) => {
        if (ids.includes(id)) {
          cleanup();
          resolve({ id, data });
        }
      };
      const onClose = (reason: string) => {
        cleanup();
        reject(new Error(`connection closed while waiting for 0x${ids[0].toString(16)}: ${reason}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for packet 0x${ids.map((i) => i.toString(16)).join("/0x")}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("packet", onPacket);
        this.off("close", onClose);
      };
      this.on("packet", onPacket);
      this.on("close", onClose);
    });
  }

  #connect(host: string, port: number, compressed: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      socket.setNoDelay(true);
      socket.once("connect", () => {
        this.#socket = socket;
        this.#closed = false;
        this.#pending = new Uint8Array(0);
        this.#decoder = compressed ? new HuffmanDecoder() : null;
        socket.on("data", (chunk: Buffer) => this.#onData(chunk));
        socket.on("close", () => {
          if (this.#socket === socket && !this.#closed) {
            this.#closed = true;
            this.emit("close", "connection closed by server");
          }
        });
        resolve();
      });
      socket.once("error", (err) => {
        if (this.#socket === socket) {
          this.close(err.message);
        } else {
          reject(err);
        }
      });
    });
  }

  #disconnectQuietly(): void {
    const socket = this.#socket;
    this.#socket = null;
    socket?.removeAllListeners("close");
    socket?.destroy();
  }

  #onData(chunk: Uint8Array): void {
    if (this.#decoder) {
      // Each decoded chunk is exactly one server send: one or more whole packets.
      for (const block of this.#decoder.push(chunk)) {
        this.#dispatch(block, true);
      }
      return;
    }
    const merged = new Uint8Array(this.#pending.length + chunk.length);
    merged.set(this.#pending);
    merged.set(chunk, this.#pending.length);
    this.#pending = this.#dispatch(merged, false);
  }

  /** Emits every whole packet in `data`; returns the incomplete tail. */
  #dispatch(data: Uint8Array, complete: boolean): Uint8Array {
    let offset = 0;
    while (offset < data.length) {
      let length = packetLength(data, offset);
      if (complete && (length === 0 || offset + length > data.length)) {
        length = data.length - offset; // unknown or odd length: trust the send boundary
      }
      if (length === 0 || offset + length > data.length) {
        break;
      }
      const packet = data.slice(offset, offset + length);
      offset += length;
      try {
        this.emit("packet", packet[0], packet);
      } catch (err) {
        this.log(`handler for 0x${packet[0].toString(16)} failed: ${(err as Error).stack}`);
      }
    }
    return data.subarray(offset);
  }
}

/** 0xA9: character names by slot ("" = free) and the number of starting cities. */
export function parseCharacterList(data: Uint8Array): { names: string[]; cityCount: number } {
  const r = new PacketReader(data, 3);
  const count = r.u8();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    names.push(r.fixedString(30).trim());
    r.skip(30);
  }
  const cityCount = r.u8();
  return { names, cityCount };
}
