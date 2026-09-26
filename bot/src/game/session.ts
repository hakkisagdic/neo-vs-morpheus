// A logged-in bot: client + world state, plus the GM helpers the orchestrator needs.
import { config, requireSetting } from "../config.ts";
import { UoClient, type LoginResult } from "../uo/client.ts";
import * as out from "../uo/outgoing.ts";
import { World } from "../world/world.ts";

/** Starting template for new bot characters: a young mage (stats total 90, skills 120). */
export const NEW_MAGE = {
  female: false,
  str: 30,
  dex: 10,
  int: 50,
  // Magery 50, Meditation 30, Eval Int 30, Wrestling 10 (0-based skill ids)
  skills: [
    [25, 50],
    [46, 30],
    [16, 30],
    [43, 10],
  ],
  skinHue: 0x03ea,
  hairStyle: 0x203b,
  hairHue: 0x044e,
} as const;

export class Session {
  readonly name: string;
  readonly client: UoClient;
  readonly world = new World();
  login: LoginResult | null = null;

  constructor(name: string, log: (message: string) => void = () => {}) {
    this.name = name;
    this.client = new UoClient(log);
    this.client.on("packet", (id, data) => this.world.apply(id, data));
  }

  /** Logs a bot in; accounts and characters are created on first use. */
  static async bot(name: string, log?: (message: string) => void): Promise<Session> {
    const s = new Session(name, log);
    await s.#connect(name.toLowerCase(), requireSetting(config.botPassword, "BOT_PASSWORD"));
    return s;
  }

  /** Logs the owner (GM) account in with its character "Architect". */
  static async gm(log?: (message: string) => void): Promise<Session> {
    const s = new Session("Architect", log);
    await s.#connect(config.ownerAccount, requireSetting(config.ownerPassword, "NEO_OWNER_PASS"));
    return s;
  }

  async #connect(account: string, password: string): Promise<void> {
    this.login = await this.client.login({
      host: config.uoHost,
      port: config.uoPort,
      account,
      password,
      character: this.name,
      clientVersion: config.clientVersion,
      newCharacter: NEW_MAGE,
    });
    // Full status (mana, stats) and skills for ourselves, and the backpack's contents.
    this.client.send(out.statusRequest(this.world.playerSerial, 4));
    this.client.send(out.statusRequest(this.world.playerSerial, 5));
    if (this.world.backpack) {
      this.client.send(out.doubleClick(this.world.backpack));
    }
  }

  say(text: string): void {
    this.client.send(out.speech(text));
  }

  /**
   * Runs a NeoArena GM command and resolves with its "NEO ..." reply (without the prefix).
   * Rejects on "NEO error ..." or when no reply arrives.
   */
  command(text: string, timeoutMs = 5_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const onJournal = (entry: { text: string; serial: number }) => {
        if (!entry.text.startsWith("NEO ")) {
          return;
        }
        cleanup();
        const reply = entry.text.slice(4);
        if (reply.startsWith("error ")) {
          reject(new Error(`${text}: ${reply.slice(6)}`));
        } else {
          resolve(reply);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`no reply to ${text}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.world.off("journal", onJournal);
      };
      this.world.on("journal", onJournal);
      this.say(text);
    });
  }

  close(): void {
    this.client.close();
  }
}
