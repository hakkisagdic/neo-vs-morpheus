// Settings from the environment (the repo-root .env is loaded by `npm run nvm`).

const env = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;
const envInt = (name: string, fallback: number): number => {
  const value = Number.parseInt(env(name), 10);
  return Number.isFinite(value) ? value : fallback;
};

export const config = {
  uoHost: env("UO_HOST", "127.0.0.1"),
  uoPort: envInt("UO_PORT", 2593),
  clientVersion: env("UO_CLIENT_VERSION", "7.0.102.3"),
  /** Password for the bot accounts (neo, morpheus, ...); they are created on first login. */
  botPassword: env("BOT_PASSWORD"),
  ownerAccount: env("NEO_OWNER_USER", "architect"),
  ownerPassword: env("NEO_OWNER_PASS"),
  layaUrl: env("LAYA_URL", "http://127.0.0.1:8000"),
  /** A second Laya server, for a fighter spec "laya-b": another checkpoint in the same match (lab/mac/lane.sh: 8101+i). */
  layaUrlB: env("LAYA_URL_B", "http://127.0.0.1:8100"),
  /** Cloudflare's Clef or Clef-flash on this Mac (lab/clef/serve.py), Jev's API. */
  clefUrl: env("CLEF_URL", "http://127.0.0.1:8200"),
  layaApiKey: env("LAYA_API_KEY"),
  jevUrl: env("JEV_URL", "https://api.typesafe.ai"),
  jevPath: env("JEV_PATH", "/v1/systemone"),
  jevApiKey: env("JEV_API_KEY"),
  jevModel: env("JEV_MODEL"), // TypeSafe: jev-latest; FreeJev rejects the field
  monitorPort: envInt("MONITOR_PORT", 8765),
  /** Where matches run, for runs gathered from several machines (lab/vm, the fleet). */
  fleetInstance: env("FLEET_INSTANCE"),
  fleetLane: env("FLEET_LANE"),
  /** The benchmark track a run belongs to ("uo-bench/1:duel-ml"); bench runs are kept apart from selection. */
  bench: env("BENCH"),
  /** How long the scripted bot takes to act on a decision: a fair rival thinks too (Laya: 0.25 s). */
  rulesReactionMs: envInt("RULES_REACTION_MS", 100),
};

export function requireSetting(value: string, name: string): string {
  if (!value) {
    throw new Error(`${name} is not set; add it to .env (see .env.example)`);
  }
  return value;
}
