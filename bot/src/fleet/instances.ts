// The machines that play matches and how to reach them, from fleet.json at the repo root
// (git-ignored; fleet.example.json shows the shape):
//   local    this Mac: its runs are already in runs/
//   ssh-lab  a Linux host running lab/compose.yml (arena server + runner), reached over ssh; it has
//            no GPU, so it plays the scripted bot only
//   colab    a Colab VM set up with lab/vm (arena, bot and Laya on its GPU), reached through
//            colab-bridge; its runs come back through a private Hugging Face dataset
// Runs from elsewhere land in runs/ as "<instance>--<stamp>.json", next to the Mac's own.
import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { readRuns } from "./results.ts";

export const ROOT = join(import.meta.dirname, "..", "..", "..");
const CACHE = join(ROOT, ".fleet");
const RUNS = join(ROOT, "runs");

export type InstanceConfig =
  | { kind: "local" }
  | { kind: "ssh-lab"; host: string; port?: number; repo: string; runner?: string }
  | { kind: "kaggle"; kernels: string[] }
  | { kind: "camber"; stash: string }
  | {
      kind: "colab";
      /** colab-bridge (a notebook tab; its Colab secrets reach the VM) or Google's Colab CLI (no tab, no secrets). */
      via?: "bridge" | "cli";
      bridge?: string[];
      /** The Colab CLI session (colab new -s NAME). */
      session?: string;
      /**
       * "fetch": runs come back packed through the bridge's fetch instead of the VM shipping them to
       * Hugging Face (an account without the HF_TOKEN Colab secret).
       */
      pull?: "ship" | "fetch";
      /** HOME for the Colab CLI: one folder per Google account, each with its own login. */
      home?: string;
      dir?: string;
      runsRepo: string;
      modelsRepo: string;
    };

/** modelB: a second checkpoint for "laya-b" fighters (Mac lanes: its server on 8101+lane). */
export type StartOptions = { series: string; lane?: number; parallel?: number; model?: string; modelB?: string };

/** One lane as the dashboard shows it. */
/** One lane; `updatedAt` (ms) is when its log last changed, where that can be seen. */
export type LaneInfo = { lane: number; model?: string; running: boolean; series?: string; done: number; total?: number; last?: string; updatedAt?: number };

/** A machine at a glance: a few summary lines and its lanes. */
export type InstanceInfo = { name: string; kind: string; ok: boolean; error?: string; summary: string[]; lanes: LaneInfo[] };

export interface Instance {
  readonly name: string;
  /** Makes the machine ready to play (a fresh VM: the arena, the bot, this checkout's changes). */
  setup(): Promise<string>;
  status(): Promise<string>;
  /** The same as status, as data for the dashboard. */
  info(): Promise<InstanceInfo>;
  /** Brings the instance's new runs into runs/. */
  pull(): Promise<string>;
  start(o: StartOptions): Promise<string>;
  stop(lane?: number): Promise<string>;
  logs(lane?: number, lines?: number): Promise<string>;
}

export async function loadFleet(path = join(ROOT, "fleet.json")): Promise<Instance[]> {
  if (!existsSync(path)) {
    throw new Error(`no ${path}: copy fleet.example.json and fill in the machines`);
  }
  const { instances } = JSON.parse(await readFile(path, "utf8")) as { instances: Record<string, InstanceConfig> };
  return Object.entries(instances).map(([name, c]) => {
    switch (c.kind) {
      case "local":
        return new Local(name);
      case "ssh-lab":
        return new SshLab(name, c);
      case "colab":
        return new Colab(name, c);
      case "kaggle":
        return new Kaggle(name, c);
      case "camber":
        return new Camber(name, c);
      default:
        throw new Error(`${name}: unknown kind ${(c as { kind: string }).kind}`);
    }
  });
}

export function pick(fleet: Instance[], name?: string): Instance[] {
  if (!name) {
    return fleet;
  }
  const found = fleet.filter((i) => i.name === name);
  if (!found.length) {
    throw new Error(`no instance ${name}; one of ${fleet.map((i) => i.name).join(", ")}`);
  }
  return found;
}

/** Runs a program without a terminal or stdin (ssh must not read ours) and returns its output. */
export function run(cmd: string, args: string[], timeoutMs = 120_000, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(out.trim());
      } else {
        reject(new Error(`${cmd} exited with ${code}: ${(err || out).trim().slice(-800)}`));
      }
    });
  });
}

/** "colab-a100--2026-10-01T21-30-00-000Z.json" for a run from colab-a100, whatever it was called there. */
export function importedName(file: string, instance: string): string {
  const base = basename(file).replace(/\.gz$/, "");
  return base.startsWith(`${instance}--`) ? base : `${instance}--${base}`;
}

/** Copies complete runs (they parse) from dir into runs/, skipping the ones already there. */
export async function importRuns(dir: string, instance: string, runs = RUNS): Promise<number> {
  await mkdir(runs, { recursive: true });
  let added = 0;
  for (const file of await readdir(dir).catch(() => [] as string[])) {
    if (!/\.json(\.gz)?$/.test(file)) {
      continue;
    }
    const target = join(runs, importedName(file, instance));
    if (existsSync(target)) {
      continue;
    }
    const raw = await readFile(join(dir, file));
    const data = file.endsWith(".gz") ? gunzipSync(raw) : raw;
    try {
      JSON.parse(data.toString("utf8"));
    } catch {
      continue; // still being written over there; the next pull takes it
    }
    await writeFile(target, data);
    added++;
  }
  return added;
}

/** Output of a command that exits 1 for "differences found" (git diff --no-index). */
function output(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 || code === 1 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`))));
  });
}

/**
 * What a VM that clones GitHub's main lacks of this checkout: commits not pushed yet, changes not
 * committed, and new files in the folders a match needs. Empty when GitHub has it all.
 */
export async function workingTreePatch(): Promise<string> {
  await run("git", ["-C", ROOT, "fetch", "-q", "origin", "main"]);
  let patch = await output("git", ["diff", "--binary", "origin/main", "--", "."]);
  const folders = ["bot/src", "bot/test", "lab", "tactics", "templates", "training", "server/overlay"];
  const untracked = (await output("git", ["ls-files", "--others", "--exclude-standard", "--", ...folders])).split("\n").filter(Boolean);
  for (const file of untracked) {
    patch += await output("git", ["diff", "--binary", "--no-index", "--", "/dev/null", file]);
  }
  return patch;
}

/** An InstanceInfo as the CLI and the MCP tools print it. */
export function formatInfo(i: InstanceInfo): string {
  const lanes = i.lanes.map(
    (l) =>
      `lane ${l.lane} [${l.model ?? "?"}]: ${l.running ? "running" : "idle"}, ${l.done}${l.total ? `/${l.total}` : ""} entries done` +
      `${l.series ? ` (${l.series})` : ""}; last: ${l.last ?? "-"}`,
  );
  return [...i.summary, ...lanes].join("\n") || "nothing to report";
}

const hfCli = () => (existsSync(join(ROOT, ".laya", "venv", "bin", "hf")) ? join(ROOT, ".laya", "venv", "bin", "hf") : "hf");

const seriesPath = (series: string) => (isAbsolute(series) ? series : existsSync(series) ? series : join(ROOT, series));

/**
 * This Mac: lanes of lab/mac (an arena server in Docker per lane, the series run natively, a Laya
 * server per lane on the GPU through Metal). Logs and series files live in .fleet/mac.
 */
class Local implements Instance {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  get #dir() {
    return join(CACHE, "mac");
  }

  /** {port: checkpoint folder} for the Laya servers lab/mac/model.sh started ("mac-laya-<port> ... <checkpoint>"). */
  async #servers(): Promise<Map<number, string>> {
    const out = await run("pgrep", ["-lf", "mac-laya-"]).catch(() => "");
    const servers = new Map<number, string>();
    for (const line of out.split("\n")) {
      const m = line.match(/mac-laya-(\d+) .* (\S+)$/);
      if (m) {
        servers.set(Number(m[1]), basename(m[2]));
      }
    }
    return servers;
  }

  async #lanesRunning(): Promise<Set<number>> {
    const out = await run("pgrep", ["-lf", "mac-series-"]).catch(() => "");
    return new Set([...out.matchAll(/mac-series-(\d+) /g)].map((m) => Number(m[1])));
  }

  async info(): Promise<InstanceInfo> {
    const [servers, running] = [await this.#servers(), await this.#lanesRunning()];
    const lanes: LaneInfo[] = [];
    const logs = (await readdir(this.#dir).catch(() => [] as string[])).filter((f) => /^lane-\d+\.log$/.test(f));
    for (const log of logs) {
      const lane = Number(log.match(/\d+/)![0]);
      const text = await readFile(join(this.#dir, log), "utf8");
      const batch = text.slice(Math.max(0, text.lastIndexOf("### ")));
      const series = batch.startsWith("### ") ? batch.split("\n")[0].split(" ")[2] : undefined;
      const results = batch.match(/^result: .*$/gm) ?? [];
      const total = series ? await readFile(join(this.#dir, "series", series), "utf8").then((t) => (JSON.parse(t) as unknown[]).length).catch(() => undefined) : undefined;
      const updatedAt = (await stat(join(this.#dir, log)).catch(() => null))?.mtimeMs;
      lanes.push({ lane, model: servers.get(8001 + lane), running: running.has(lane), series, done: results.length, total, last: results.at(-1)?.slice("result: ".length), updatedAt });
    }
    lanes.sort((a, b) => a.lane - b.lane);
    const load = (await run("sysctl", ["-n", "vm.loadavg"]).catch(() => "")).replace(/[{}]/g, "").trim().split(/\s+/);
    const runs = (await readdir(RUNS).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).length;
    return {
      name: this.name,
      kind: "mac",
      ok: true,
      summary: [`load ${load[0] ?? "?"} (5 min ${load[1] ?? "?"})`, `${servers.size} Laya servers on Metal`, `${runs} run files in runs/ from every machine`],
      lanes,
    };
  }

  async status(): Promise<string> {
    return formatInfo(await this.info());
  }

  async setup(): Promise<string> {
    await run("docker", ["compose", "-f", join(ROOT, "docker-compose.yml"), "build", "uo-server"], 1_800_000);
    return "arena image neo-vs-morpheus/modernuo built; lanes start with lab/mac/lane.sh (fleet start mac ...)";
  }

  async pull(): Promise<string> {
    return "runs are already here";
  }

  async start(o: StartOptions): Promise<string> {
    const lane = o.lane ?? 0;
    if ((await this.#lanesRunning()).has(lane)) {
      throw new Error(`lane ${lane} is busy; stop it first`);
    }
    const said: string[] = [];
    if (o.model && (await this.#serve(8001 + lane, o.model))) {
      said.push(`lane ${lane} now plays ${o.model}`);
    }
    if (o.modelB && (await this.#serve(8101 + lane, o.modelB))) {
      said.push(`its laya-b fighters play ${o.modelB}`);
    }
    await mkdir(join(this.#dir, "series"), { recursive: true });
    const series = join(this.#dir, "series", basename(o.series));
    await writeFile(series, await readFile(seriesPath(o.series), "utf8"));
    const log = join(this.#dir, `lane-${lane}.log`);
    await writeFile(log, `### ${new Date().toISOString()} ${basename(series)}\n`, { flag: "a" });
    detach(join(ROOT, "lab", "mac", "lane.sh"), [String(lane), series, "--parallel", String(o.parallel ?? 8)], log);
    said.push(`started ${basename(series)} on lane ${lane} (${o.parallel ?? 8} arenas)`);
    return said.join("; ");
  }

  /** A Laya server on the port with the checkpoint (fetched from the hub if missing); false if it already served it. */
  async #serve(port: number, model: string): Promise<boolean> {
    if ((await this.#servers()).get(port) === model) {
      return false;
    }
    const checkpoint = join(ROOT, "training", "checkpoints", model);
    if (!existsSync(join(checkpoint, "rl_agent_config.json"))) {
      await run(hfCli(), ["download", "hakkisagdic/laya-neo-duel", "--revision", model, "--local-dir", checkpoint, "--quiet"], 3_600_000);
    }
    await run("pkill", ["-f", `mac-laya-${port} `]).catch(() => "");
    await new Promise((r) => setTimeout(r, 2_000));
    detach(join(ROOT, "lab", "mac", "model.sh"), [String(port), checkpoint], join(this.#dir, `laya-${port}.log`));
    for (let i = 0; i < 90 && !(await laya(port)); i++) {
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return true;
  }

  async stop(lane?: number): Promise<string> {
    await run("pkill", ["-f", lane === undefined ? "mac-series-" : `mac-series-${lane} `]).catch(() => "");
    return `stopped ${lane === undefined ? "every lane" : `lane ${lane}`}`;
  }

  async logs(lane = 0, lines = 40): Promise<string> {
    const text = await readFile(join(this.#dir, `lane-${lane}.log`), "utf8").catch(() => `no log for lane ${lane}`);
    return text.split("\n").slice(-Math.min(lines, 500)).join("\n");
  }
}

/** Starts a script that outlives this process, its output appended to log. */
function detach(script: string, args: string[], log: string): void {
  const fd = openSync(log, "a");
  spawn("bash", [script, ...args], { detached: true, stdio: ["ignore", fd, fd] }).unref();
}

async function laya(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
    return (await res.text()).includes("typed-decisions");
  } catch {
    return false;
  }
}

class SshLab implements Instance {
  readonly name: string;
  readonly #c: Extract<InstanceConfig, { kind: "ssh-lab" }>;

  constructor(name: string, c: Extract<InstanceConfig, { kind: "ssh-lab" }>) {
    this.name = name;
    this.#c = c;
  }

  get #runner() {
    return this.#c.runner ?? "laya-runner";
  }

  #ssh(command: string, timeoutMs?: number): Promise<string> {
    return run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-p", String(this.#c.port ?? 22), this.#c.host, command], timeoutMs);
  }

  /** The runner's series processes as host pids and arguments (the slim node image has no ps or pgrep). */
  get #seriesProcesses(): string {
    return `docker top ${this.#runner} -o pid,args | awk 'NR>1 && /cli.ts series/'`;
  }

  #rsync(...args: string[]): Promise<string> {
    return run("rsync", ["-a", "-e", `ssh -o BatchMode=yes -p ${this.#c.port ?? 22}`, ...args], 600_000);
  }

  /** Host pids of each lane's series ("laya-lane-<i> src/cli.ts series …"); an untagged series is lane 0's. */
  async #lanesRunning(): Promise<Map<number, string[]>> {
    const lanes = new Map<number, string[]>();
    for (const line of (await this.#ssh(this.#seriesProcesses)).split("\n").filter(Boolean)) {
      const [pid, ...args] = line.trim().split(/\s+/);
      const lane = Number(args.join(" ").match(/laya-lane-(\d+)/)?.[1] ?? 0);
      lanes.set(lane, [...(lanes.get(lane) ?? []), pid]);
    }
    return lanes;
  }

  /**
   * Lane i plays on arena server i: lane 0 on the lab's laya-uo-server (172.30.0.10), the others on
   * laya-uo-server-<i> (172.30.0.10+i), started here when missing, 1.5 CPU and 2.5 GB each, with the
   * runner raised to 2 CPU and 3 GB: three lanes stay within the host's 6 CPU and 10 GB for the lab.
   */
  async #ensureServer(lane: number): Promise<void> {
    if (lane === 0) {
      return;
    }
    const name = `laya-uo-server-${lane}`;
    const ip = `172.30.0.${10 + lane}`;
    const r = this.#c.repo;
    await this.#ssh(
      `docker update --cpus 2 --memory 3g --memory-swap 3g ${this.#runner} >/dev/null; ` +
        `docker ps --format '{{.Names}}' | grep -qx ${name} || { docker rm -f ${name} >/dev/null 2>&1; ` +
        `docker run -d --name ${name} --network laya-net --ip ${ip} --cpus 1.5 --memory 2500m --memory-swap 2500m --cpu-shares 512 --init ` +
        `--restart unless-stopped --env-file ${r}/lab/.env -e NEO_OWNER_USER=architect -e NEO_PUBLIC_ADDRESS=${ip} -e "NEO_SERVER_NAME=lab ${lane}" ` +
        `-e NEO_EXPANSION=7 -e NEO_REAGENTS=200 -v ${name}-world:/app/World -v ${r}/server/client-files:/uodata:ro ` +
        `-v ${r}/templates:/app/NeoTemplates:ro laya-modernuo:225c634 >/dev/null && sleep 30; }`,
      240_000,
    );
  }

  async setup(): Promise<string> {
    return "set up by hand once: lab/compose.yml on the host (fleet start syncs the code each time)";
  }

  async status(): Promise<string> {
    const r = this.#c.repo;
    return this.#ssh(
      [
        "uptime | sed 's/.*load/load/'",
        "free -g | awk 'NR==2{print \"memory: \" $7 \" GB available of \" $2}'",
        "docker ps --filter name=laya- --format '{{.Names}}: {{.Status}}'",
        `echo "series: $(${this.#seriesProcesses} | sed 's/.*cli.ts series //' | tr '\\n' ' ')"`,
        `for f in ${r}/lab/logs/lane-*.log; do [ -f "$f" ] && awk -v f="$(basename $f)" '/^### /{n=0; h=$0; last=""} /^result:/{n++; last=$0} END{print f ": " n " results since " h "; last " last}' "$f"; done`,
        `echo "runs there: $(ls ${r}/runs | wc -l)"`,
      ].join("; "),
    );
  }

  async info(): Promise<InstanceInfo> {
    const [text, running] = await Promise.all([this.status(), this.#lanesRunning()]);
    const lanes: LaneInfo[] = [...text.matchAll(/^lane-(\d+)\.log: (\d+) results since ### (\S+) (\S+); last (.*)$/gm)].map((m) => ({
      lane: Number(m[1]),
      model: "scripted bot (no GPU)",
      running: running.has(Number(m[1])),
      series: m[4],
      done: Number(m[2]),
      last: m[5].replace(/^result: /, "") || undefined,
    }));
    return { name: this.name, kind: "ssh-lab", ok: true, summary: text.split("\n").filter((l) => /^(load|memory|runs there)/.test(l)), lanes };
  }

  async pull(): Promise<string> {
    const cache = join(CACHE, this.name, "runs");
    await mkdir(cache, { recursive: true });
    await this.#rsync(`${this.#c.host}:${this.#c.repo}/runs/`, `${cache}/`);
    return `${await importRuns(cache, this.name)} new runs`;
  }

  async start(o: StartOptions): Promise<string> {
    if (o.model) {
      throw new Error(`${this.name} has no GPU: Laya does not run there, only the scripted bot`);
    }
    const lane = o.lane ?? 0;
    if ((await this.#lanesRunning()).has(lane)) {
      throw new Error(`lane ${lane} is busy (one series per arena server); stop it first`);
    }
    // The runner mounts the repo there: the code, tactics and templates go over first.
    for (const dir of ["bot/src", "tactics", "templates"]) {
      await this.#rsync("--delete", `${join(ROOT, dir)}/`, `${this.#c.host}:${this.#c.repo}/${dir}/`);
    }
    const local = seriesPath(o.series);
    const file = basename(local);
    await this.#ssh(`mkdir -p ${this.#c.repo}/lab/series ${this.#c.repo}/lab/logs`);
    await this.#rsync(local, `${this.#c.host}:${this.#c.repo}/lab/series/${file}`);
    await this.#ensureServer(lane);
    const parallel = o.parallel ?? 8;
    const log = `/work/lab/logs/lane-${lane}.log`;
    await this.#ssh(
      `docker exec -d -e FLEET_INSTANCE=${this.name} -e FLEET_LANE=${lane} -e UO_HOST=172.30.0.${10 + lane} -e MONITOR_PORT=${9000 + 100 * lane} ` +
        `${this.#runner} bash -c "cd /work/bot && echo '### $(date -u +%FT%TZ) ${file}' >> ${log} && ` +
        `exec -a laya-lane-${lane} node src/cli.ts series ../lab/series/${file} --parallel ${parallel} >> ${log} 2>&1"`,
    );
    return `started ${file} on lane ${lane} (${parallel} arenas)`;
  }

  async stop(lane?: number): Promise<string> {
    const lanes = await this.#lanesRunning();
    const pids = lane === undefined ? [...lanes.values()].flat() : (lanes.get(lane) ?? []);
    if (!pids.length) {
      return "no series running";
    }
    await this.#ssh(`kill ${pids.join(" ")}`);
    return `series stopped (${pids.length} process${pids.length > 1 ? "es" : ""})`;
  }

  async logs(lane = 0, lines = 40): Promise<string> {
    return this.#ssh(`tail -n ${Math.min(lines, 500)} ${this.#c.repo}/lab/logs/lane-${lane}.log 2>/dev/null || echo 'no log for lane ${lane}'`);
  }
}

/** Python run in the Colab kernel through colab-bridge; it answers after a FLEET>>> marker. */
const PY_HELPERS = `
import glob, json, os, re, subprocess, sys, time, urllib.request
def sh(c):
    # Patterns for pgrep/pkill start "[a]rena-": the shell running them has the pattern in its own command line.
    return subprocess.run(c, shell=True, capture_output=True, text=True).stdout.strip()
def laya_servers():
    """{port: checkpoint folder} for every Laya server, read from each process's environment."""
    out = {}
    for pid in sh("pgrep -f serve_checkpoint.py").split():
        try:
            env = dict(e.split("=", 1) for e in open(f"/proc/{pid}/environ").read().split("\\0") if "=" in e)
            args = open(f"/proc/{pid}/cmdline").read().split("\\0")
            out[int(env.get("LAYA_PORT", 0))] = (int(pid), os.path.basename(args[-1] or args[-2]).rstrip("/"))
        except (OSError, ValueError):
            pass
    return out
`;

class Colab implements Instance {
  readonly name: string;
  readonly #c: Extract<InstanceConfig, { kind: "colab" }>;

  constructor(name: string, c: Extract<InstanceConfig, { kind: "colab" }>) {
    this.name = name;
    this.#c = c;
  }

  get #dir() {
    return this.#c.dir ?? "/content/arena";
  }

  get #cli() {
    return this.#c.via === "cli";
  }

  get #session() {
    return this.#c.session ?? "arena";
  }

  /** The Colab CLI's environment: its own HOME, and so its own login, per Google account. */
  get #cliEnv(): NodeJS.ProcessEnv | undefined {
    return this.#c.home ? { ...process.env, HOME: this.#c.home.replace(/^~(?=\/|$)/, homedir()) } : undefined;
  }

  /** A file to or from the VM through the Colab CLI; through the bridge, downloads only (its fetch). */
  #copy(direction: "upload" | "download", from: string, to: string): Promise<string> {
    if (!this.#cli) {
      if (direction === "upload") {
        throw new Error(`${this.name}: the bridge cannot upload; put the file where the VM can download it`);
      }
      return run("colab-bridge", [...(this.#c.bridge ?? []), "fetch", from, to], 3_600_000);
    }
    return run("colab", [direction, "-s", this.#session, from, to], 3_600_000, this.#cliEnv);
  }

  async #cell(action: string, body: string, timeoutMs = 300_000): Promise<string> {
    await mkdir(join(CACHE, this.name), { recursive: true });
    const file = join(CACHE, this.name, `cell-${action}.py`);
    const code = `# fleet ${this.name}: ${action}\ndef _fleet():\n${PY_HELPERS.replace(/^/gm, "    ")}\n${body.replace(/^/gm, "    ")}\n_fleet()\n`;
    await writeFile(file, code);
    const out = this.#cli
      ? await run("colab", ["exec", "-s", this.#session, "-f", file, "--timeout", String(Math.round(timeoutMs / 1000))], timeoutMs + 60_000, this.#cliEnv)
      : await run("colab-bridge", [...(this.#c.bridge ?? []).map((a) => a.replace(/^~(?=\/)/, homedir())), "run", file], timeoutMs);
    const at = out.lastIndexOf("FLEET>>>");
    if (at < 0) {
      throw new Error(`no answer from ${this.name}:\n${out.slice(-1500)}`);
    }
    return out.slice(at + "FLEET>>>".length).trim();
  }

  async setup(): Promise<string> {
    const commit = await run("git", ["-C", ROOT, "rev-parse", "origin/main"]);
    const patch = await workingTreePatch();
    return this.#cell(
      "setup",
      `A = ${JSON.stringify(this.#dir)}
os.makedirs(A, exist_ok=True)
patch = ${JSON.stringify(patch)}
if patch:
    with open(f"{A}/working-tree.patch", "w") as fh:
        fh.write(patch)
elif os.path.exists(f"{A}/working-tree.patch"):
    os.remove(f"{A}/working-tree.patch")
if sh("pgrep -f '[s]etup.sh'"):
    print("FLEET>>>setup is running already; see " + A + "/setup.log"); return
urllib.request.urlretrieve(${JSON.stringify(`https://raw.githubusercontent.com/hakkisagdic/neo-vs-morpheus/${commit}/lab/vm/setup.sh`)}, f"{A}/setup.sh")
subprocess.Popen(["bash", f"{A}/setup.sh"], cwd=A, env=dict(os.environ, ARENA_DIR=A, COMMIT=${JSON.stringify(commit)}),
                 stdout=open(f"{A}/setup.log", "a"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
gpu = sh("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader")
cpus, ram = sh("nproc"), sh("free -g | awk 'NR==2{print $2}'")
extra = " plus this checkout" if patch else ""
print(f"FLEET>>>setup started at ${commit.slice(0, 7)}{extra} ({len(patch)} bytes of patch); {cpus} CPUs, {ram} GB, {gpu}; log {A}/setup.log")`,
    );
  }

  async status(): Promise<string> {
    return this.#cell(
      "status",
      `A = ${JSON.stringify(this.#dir)}
lines = [sh("uptime | sed 's/.*load/load/'"), "gpu: " + sh("nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader")]
servers = laya_servers()
for log in sorted(glob.glob(f"{A}/lane-*.series.log"), key=lambda p: int(re.search(r"lane-(\\d+)", p).group(1))):
    i = int(re.search(r"lane-(\\d+)", log).group(1))
    text = open(log).read()
    batch = text[text.rfind("\\n### ") + 1:] if "\\n### " in text else text
    head = batch.splitlines()[0][4:] if batch.startswith("### ") else ""
    results = re.findall(r"^result: .*$", batch, re.M)
    running = sh(f"pgrep -fa '[a]rena-series-{i} '")
    total = ""
    m = re.search(r"series (\\S+\\.json)", running)
    if m and os.path.exists(m.group(1)):
        total = f"/{len(json.load(open(m.group(1))))}"
    model = servers.get(8001 + i, (0, "no Laya server"))[1]
    lines.append(f"lane {i} [{model}]: {'running' if running else 'idle'}, {len(results)}{total} entries done {('(' + head + ')') if head else ''}; last: {results[-1] if results else '-'}")
if not glob.glob(f"{A}/lane-*.series.log") and os.path.exists(f"{A}/setup.log"):
    lines.append("setup: " + sh(f"grep '^== ' {A}/setup.log | tail -1") + ("" if sh("pgrep -f '[s]etup.sh'") else " (finished)"))
shipper = "running" if sh("pgrep -f '[s]hip.py'") else "off"
lines.append(f"runs there: {len(glob.glob(A + '/nvm/runs/*.json'))}; shipper: {shipper}")
print("FLEET>>>" + "\\n".join(lines))`,
    );
  }

  async info(): Promise<InstanceInfo> {
    const text = await this.status();
    const lanes: LaneInfo[] = [...text.matchAll(/^lane (\d+) \[([^\]]*)\]: (running|idle), (\d+)(?:\/(\d+))? entries done.*?; last: (.*)$/gm)].map((m) => ({
      lane: Number(m[1]),
      model: m[2],
      running: m[3] === "running",
      done: Number(m[4]),
      total: m[5] ? Number(m[5]) : undefined,
      last: m[6].replace(/^result: /, ""),
    }));
    return { name: this.name, kind: "colab", ok: true, summary: text.split("\n").filter((l) => !l.startsWith("lane ")), lanes };
  }

  async pull(): Promise<string> {
    if (this.#cli || this.#c.pull === "fetch") {
      return this.#pullThroughCli();
    }
    const shipped = await this.#cell(
      "ship",
      `from google.colab import userdata
A, name, repo = ${JSON.stringify(this.#dir)}, ${JSON.stringify(this.name)}, ${JSON.stringify(this.#c.runsRepo)}
out = subprocess.run([sys.executable, f"{A}/nvm/lab/vm/ship.py", name, repo, "--once"], capture_output=True, text=True,
                     env=dict(os.environ, ARENA_DIR=A, HF_TOKEN=userdata.get("HF_TOKEN")))
if out.returncode:
    print("FLEET>>>ship failed: " + (out.stderr or out.stdout)[-500:]); return
print("FLEET>>>" + out.stdout.split()[-1])`,
      900_000,
    );
    const cache = join(CACHE, "hf", this.#c.runsRepo.replace("/", "--"));
    await run(hfCli(), ["download", this.#c.runsRepo, "--repo-type", "dataset", "--include", `${this.name}/*`, "--local-dir", cache, "--quiet"], 900_000);
    if (!/^\d+$/.test(shipped)) {
      throw new Error(shipped);
    }
    return `${shipped} runs shipped, ${await importRuns(join(cache, this.name), this.name)} new here`;
  }

  /**
   * Without Colab secrets the VM cannot push to Hugging Face, so this Mac fetches: the VM packs the
   * runs this Mac lacks, and the CLI downloads the pack. Nothing is marked shipped over there, so a
   * failed download is simply fetched again next time.
   */
  async #pullThroughCli(): Promise<string> {
    const have = (await readdir(RUNS).catch(() => [] as string[])).filter((f) => f.startsWith(`${this.name}--`));
    const packed = await this.#cell(
      "pack",
      `import tarfile
A, name = ${JSON.stringify(this.#dir)}, ${JSON.stringify(this.name)}
have = set(${JSON.stringify(have)})
os.makedirs(f"{A}/ship", exist_ok=True)
pack = f"{A}/ship/pull.tar.gz"
n = 0
with tarfile.open(pack, "w:gz") as tar:
    for path in sorted(glob.glob(f"{A}/nvm/runs/*.json")):
        base = os.path.basename(path)
        target = base if base.startswith(name + "--") else f"{name}--{base}"
        if target in have:
            continue
        try:
            json.load(open(path))
        except ValueError:
            continue
        tar.add(path, arcname=target)
        n += 1
print(f"FLEET>>>{n}")`,
    );
    if (!/^\d+$/.test(packed)) {
      throw new Error(packed);
    }
    if (packed === "0") {
      return "0 runs new there";
    }
    const cache = join(CACHE, this.name);
    const pack = join(cache, "pull.tar.gz");
    await mkdir(join(cache, "runs"), { recursive: true });
    await this.#copy("download", `${this.#dir}/ship/pull.tar.gz`, pack);
    await run("tar", ["-xzf", pack, "-C", join(cache, "runs")]);
    await rm(pack, { force: true });
    return `${packed} runs fetched, ${await importRuns(join(cache, "runs"), this.name)} new here`;
  }

  /** The CLI's VM cannot reach the private model repo: the checkpoint goes over from this Mac. */
  async #provideModel(tag: string): Promise<void> {
    const there = await this.#cell(
      "has-model",
      `print("FLEET>>>" + ("yes" if os.path.exists(${JSON.stringify(`${this.#dir}/models/${tag}/rl_agent_config.json`)}) else "no"))`,
    );
    if (there === "yes") {
      return;
    }
    const checkpoints = join(ROOT, "training", "checkpoints");
    if (!existsSync(join(checkpoints, tag, "rl_agent_config.json"))) {
      await run(hfCli(), ["download", this.#c.modelsRepo, "--revision", tag, "--local-dir", join(checkpoints, tag), "--quiet"], 3_600_000);
    }
    // In 50 MB parts, into a folder that exists first: the upload answers 400 for a missing folder or a part over ~60 MB.
    const parts = join(CACHE, this.name, `${tag}.parts`);
    await rm(parts, { recursive: true, force: true });
    await mkdir(parts, { recursive: true });
    const remote = `${this.#dir}/models/${tag}.parts`;
    await this.#cell("model-parts", `sh(${JSON.stringify(`rm -rf ${remote} && mkdir -p ${remote}`)})
print("FLEET>>>ok")`);
    try {
      await run("sh", ["-c", `tar -cf - -C "${checkpoints}" --exclude .cache "${tag}" | split -b 50m - "${parts}/part-"`], 600_000);
      for (const part of (await readdir(parts)).sort()) {
        await this.#copy("upload", join(parts, part), `${remote}/${part}`);
      }
    } finally {
      await rm(parts, { recursive: true, force: true });
    }
    const unpacked = await this.#cell(
      "unpack-model",
      `A, tag = ${JSON.stringify(this.#dir)}, ${JSON.stringify(tag)}
sh(f"cat {A}/models/{tag}.parts/part-* | tar -xf - -C {A}/models && rm -rf {A}/models/{tag}.parts")
print("FLEET>>>" + ("ok" if os.path.exists(f"{A}/models/{tag}/rl_agent_config.json") else "missing"))`,
    );
    if (unpacked !== "ok") {
      throw new Error(`${tag} did not arrive on ${this.name}`);
    }
  }

  async start(o: StartOptions): Promise<string> {
    const lane = o.lane ?? 0;
    if (o.model && this.#cli) {
      await this.#provideModel(o.model);
    }
    const local = seriesPath(o.series);
    const file = basename(local);
    const entries = await readFile(local, "utf8");
    JSON.parse(entries); // fail here, not there
    return this.#cell(
      "start",
      `A, name, lane, model, model_b = ${JSON.stringify(this.#dir)}, ${JSON.stringify(this.name)}, ${lane}, ${JSON.stringify(o.model ?? "")}, ${JSON.stringify(o.modelB ?? "")}
if sh(f"pgrep -f '[a]rena-series-{lane} '"):
    print(f"FLEET>>>lane {lane} is busy; stop it first"); return
os.makedirs(f"{A}/series", exist_ok=True)
path = f"{A}/series/${file}"
with open(path, "w") as fh:
    fh.write(${JSON.stringify(entries)})
said = []

def serve(port, model):
    """A Laya server on the port with the checkpoint; False if it already served it, None if it did not come up."""
    if laya_servers().get(port, (0, ""))[1] == model:
        return False
    ckpt = f"{A}/models/{model}"
    if ${this.#cli ? "True" : "False"} or os.path.exists(f"{ckpt}/rl_agent_config.json"):
        pass  # sent over from the Mac, or already here
    else:
        from google.colab import userdata
        from huggingface_hub import snapshot_download
        ckpt = snapshot_download(${JSON.stringify(this.#c.modelsRepo)}, revision=model, local_dir=f"{A}/models/{model}", token=userdata.get("HF_TOKEN"))
    old = laya_servers().get(port)
    if old:
        os.kill(old[0], 15); time.sleep(3)
    subprocess.Popen(["bash", f"{A}/nvm/lab/vm/model.sh", str(port), ckpt], env=dict(os.environ, ARENA_DIR=A),
                     stdout=open(f"{A}/laya-{port}.log", "w"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    for _ in range(120):
        try:
            if "typed-decisions" in json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2))["loaded"]:
                return True
        except Exception:
            pass
        time.sleep(2)
    return None

# The lane's model on 8001+lane; a sparring partner for "laya-b" fighters on 8101+lane.
for port, m, note in ((8001 + lane, model, f"lane {lane} now plays {model}"), (8101 + lane, model_b, f"its laya-b fighters play {model_b}")):
    if not m:
        continue
    up = serve(port, m)
    if up is None:
        print(f"FLEET>>>the Laya server for {m} did not come up; see {A}/laya-{port}.log"); return
    if up:
        said.append(note)
# Runs go to the runs dataset every 10 minutes, whoever is watching: a recycled VM takes its disk along.
# (Through the CLI there are no secrets to push with; the Mac's pull fetches instead.)
if ${this.#cli ? "False" : "True"} and not sh("pgrep -f '[s]hip.py'"):
    from google.colab import userdata
    subprocess.Popen([sys.executable, f"{A}/nvm/lab/vm/ship.py", name, ${JSON.stringify(this.#c.runsRepo)}], cwd=A,
                     env=dict(os.environ, ARENA_DIR=A, HF_TOKEN=userdata.get("HF_TOKEN")), stdout=open(f"{A}/ship.log", "a"),
                     stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    said.append("shipping runs every 10 minutes")
log = f"{A}/lane-{lane}.series.log"
with open(log, "a") as fh:
    fh.write(f"\\n### {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} ${file}\\n")
subprocess.Popen(["bash", f"{A}/nvm/lab/vm/lane.sh", str(lane), path, "--parallel", "${o.parallel ?? 8}"], cwd=A,
                 env=dict(os.environ, ARENA_DIR=A, FLEET_INSTANCE=name), stdout=open(log, "a"), stderr=subprocess.STDOUT,
                 stdin=subprocess.DEVNULL, start_new_session=True)
said.append(f"started ${file} on lane {lane} (${o.parallel ?? 8} arenas)")
print("FLEET>>>" + "; ".join(said))`,
      900_000,
    );
  }

  async stop(lane?: number): Promise<string> {
    // "[a]rena": the pattern must not match the shell that runs pkill, whose command line holds it.
    const pattern = lane === undefined ? "[a]rena-series-[0-9]" : `[a]rena-series-${lane} `;
    return this.#cell("stop", `sh(${JSON.stringify(`pkill -f '${pattern}'`)})\nprint("FLEET>>>stopped " + ${JSON.stringify(lane === undefined ? "every lane" : `lane ${lane}`)})`);
  }

  async logs(lane = 0, lines = 40): Promise<string> {
    return this.#cell("logs", `print("FLEET>>>" + sh(${JSON.stringify(`tail -n ${Math.min(lines, 500)} ${this.#dir}/lane-${lane}.series.log`)}))`);
  }
}

/** Kaggle arena kernels started by lab/kaggle_arena.py ("<name>-arena-run"); their runs arrive when a kernel ends. */
class Kaggle implements Instance {
  readonly name: string;
  readonly #c: Extract<InstanceConfig, { kind: "kaggle" }>;

  constructor(name: string, c: Extract<InstanceConfig, { kind: "kaggle" }>) {
    this.name = name;
    this.#c = c;
  }

  async #states(): Promise<{ kernel: string; state: string }[]> {
    const owner = (await run("kaggle", ["config", "view"])).match(/username:\s*(\S+)/)?.[1] ?? "";
    return Promise.all(
      this.#c.kernels.map(async (kernel) => {
        const out = await run("kaggle", ["kernels", "status", `${owner}/${kernel}-arena-run`]).catch((e: Error) => e.message);
        return { kernel, state: out.match(/status "?(?:KernelWorkerStatus\.)?(\w+)/)?.[1]?.toLowerCase() ?? "unknown" };
      }),
    );
  }

  async info(): Promise<InstanceInfo> {
    const states = await this.#states();
    const lanes: LaneInfo[] = states.map(({ kernel, state }, lane) => ({ lane, model: "2 × T4 kernel", running: state === "running", series: kernel, done: 0, last: state }));
    return { name: this.name, kind: "kaggle", ok: true, summary: [`${lanes.filter((l) => l.running).length} of ${lanes.length} arena kernels running; runs arrive when a kernel ends`], lanes };
  }

  async status(): Promise<string> {
    return formatInfo(await this.info());
  }

  async setup(): Promise<string> {
    return "nothing to set up: each run uploads its own bundle (lab/kaggle_arena.py)";
  }

  async pull(): Promise<string> {
    const notes: string[] = [];
    for (const { kernel, state } of await this.#states()) {
      if (state !== "complete") {
        notes.push(`${kernel}: ${state}, nothing to fetch yet`);
        continue;
      }
      // A finished kernel's output never changes: fetched once, it is not downloaded again.
      const marker = join(CACHE, this.name, `${kernel}.fetched`);
      if (existsSync(marker)) {
        notes.push(`${kernel}: fetched already`);
        continue;
      }
      try {
        const out = await run("python3", [join(ROOT, "lab", "kaggle_arena.py"), "fetch", "--name", kernel], 1_800_000);
        await mkdir(join(CACHE, this.name), { recursive: true });
        await writeFile(marker, `${new Date().toISOString()}\n`);
        notes.push(`${kernel}: ${out.split("\n").at(-1)}`);
      } catch (err) {
        notes.push(`${kernel}: ${(err as Error).message.split("\n").at(-1)}`);
      }
    }
    return notes.join("\n");
  }

  async start(o: StartOptions): Promise<string> {
    const name = `${basename(o.series, ".json")}-${Date.now().toString(36)}`;
    const lanes = o.model ? [o.model, o.model] : ["neo-duel-v8", "neo-duel-v8-dagger-all"];
    const out = await run(
      "python3",
      [join(ROOT, "lab", "kaggle_arena.py"), "run", "--name", name, "--series", seriesPath(o.series), ...lanes.flatMap((l) => ["--lane", l]), "--parallel", String(o.parallel ?? 6)],
      3_600_000,
    );
    return `${out.split("\n").at(-1)}\nadd "${name}" to this instance's kernels in fleet.json to follow it`;
  }

  async stop(): Promise<string> {
    throw new Error("Kaggle's CLI cannot stop a kernel: cancel it on kaggle.com");
  }

  async logs(): Promise<string> {
    return "a kernel's log comes with its output when it ends (fleet pull)";
  }
}

/**
 * Camber: a Jupyter node started in Camber's web app, the arena installed in its persistent Stash
 * (lab/vm/setup.sh without root). Its lanes write runs and lane logs there; the CLI reads them.
 */
class Camber implements Instance {
  readonly name: string;
  readonly #c: Extract<InstanceConfig, { kind: "camber" }>;

  constructor(name: string, c: Extract<InstanceConfig, { kind: "camber" }>) {
    this.name = name;
    this.#c = c;
  }

  #cli(...args: string[]): Promise<string> {
    return run(join(homedir(), ".camber", "bin", "camber"), args, 1_800_000);
  }

  async info(): Promise<InstanceInfo> {
    const runs = ((await this.#cli("stash", "ls", `${this.#c.stash}/nvm/runs/`).catch(() => "")).match(/\.json\b/g) ?? []).length;
    const root = await this.#cli("stash", "ls", `${this.#c.stash}/`).catch(() => "");
    // The node's processes are out of sight: a lane counts as running while its runs keep coming
    // (pulled every 10 minutes, after Stash's own delay).
    const since = Date.now() - 45 * 60_000;
    const active = new Set((await readRuns(RUNS, since)).filter((r) => r.instance === this.name && r.startedAt >= since).map((r) => Number(r.lane)));
    const lanes: LaneInfo[] = [];
    await mkdir(join(CACHE, this.name), { recursive: true });
    for (const lane of [...root.matchAll(/lane-(\d+)\.series\.log/g)].map((m) => Number(m[1]))) {
      const local = join(CACHE, this.name, `lane-${lane}.series.log`);
      await this.#cli("stash", "cp", `${this.#c.stash}/lane-${lane}.series.log`, local).catch(() => "");
      const text = await readFile(local, "utf8").catch(() => "");
      const results = text.match(/^result: .*$/gm) ?? [];
      lanes.push({ lane, model: "L4 (Camber)", running: active.has(lane), done: results.length, last: results.at(-1)?.slice("result: ".length) });
    }
    return { name: this.name, kind: "camber", ok: true, summary: [`${runs} runs in Stash`, "the node is started and stopped in Camber's web app"], lanes };
  }

  async status(): Promise<string> {
    return formatInfo(await this.info());
  }

  async setup(): Promise<string> {
    return "set up once from a Camber notebook: lab/vm/setup.sh with ARENA_DIR in Stash (no root)";
  }

  async pull(): Promise<string> {
    const cache = join(CACHE, this.name, "runs");
    await mkdir(cache, { recursive: true });
    await this.#cli("stash", "cp", "-r", `${this.#c.stash}/nvm/runs/`, `${cache}/`);
    return `${await importRuns(cache, this.name)} new runs`;
  }

  async start(): Promise<string> {
    throw new Error("Camber lanes start from its notebook while the node runs: bash /home/jovyan/arena/nvm/lab/vm/notebook-lanes.sh HOURS MODEL...");
  }

  async stop(): Promise<string> {
    throw new Error("stop Camber lanes from its notebook, or stop the node in the web app");
  }

  async logs(lane = 0, lines = 40): Promise<string> {
    const local = join(CACHE, this.name, `lane-${lane}.series.log`);
    await this.#cli("stash", "cp", `${this.#c.stash}/lane-${lane}.series.log`, local);
    return (await readFile(local, "utf8")).split("\n").slice(-Math.min(lines, 500)).join("\n");
  }
}
