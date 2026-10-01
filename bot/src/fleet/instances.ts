// The machines that play matches and how to reach them, from fleet.json at the repo root
// (git-ignored; fleet.example.json shows the shape):
//   local    this Mac: its runs are already in runs/
//   ssh-lab  a Linux host running lab/compose.yml (arena server + runner), reached over ssh; it has
//            no GPU, so it plays the scripted bot only
//   colab    a Colab VM set up with lab/vm (arena, bot and Laya on its GPU), reached through
//            colab-bridge; its runs come back through a private Hugging Face dataset
// Runs from elsewhere land in runs/ as "<instance>--<stamp>.json", next to the Mac's own.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { gunzipSync } from "node:zlib";

export const ROOT = join(import.meta.dirname, "..", "..", "..");
const CACHE = join(ROOT, ".fleet");
const RUNS = join(ROOT, "runs");

export type InstanceConfig =
  | { kind: "local" }
  | { kind: "ssh-lab"; host: string; port?: number; repo: string; runner?: string }
  | { kind: "colab"; bridge: string[]; dir?: string; runsRepo: string; modelsRepo: string };

export type StartOptions = { series: string; lane?: number; parallel?: number; model?: string };

export interface Instance {
  readonly name: string;
  status(): Promise<string>;
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
export function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
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

const seriesPath = (series: string) => (isAbsolute(series) ? series : existsSync(series) ? series : join(ROOT, series));

class Local implements Instance {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async status(): Promise<string> {
    const series = await run("pgrep", ["-lf", "cli.ts series"]).catch(() => "");
    const runs = (await readdir(RUNS).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).length;
    return [`${runs} run files in runs/ (from every instance)`, series ? `series running:\n${series}` : "no series running"].join("\n");
  }

  async pull(): Promise<string> {
    return "runs are already here";
  }

  async start(): Promise<string> {
    throw new Error("start the Mac's arena and series yourself: npm run nvm -- series <file> --parallel N");
  }

  async stop(): Promise<string> {
    throw new Error("stop the Mac's series yourself (Ctrl-C in its terminal)");
  }

  async logs(): Promise<string> {
    return "the Mac's series print to the terminal that started them";
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

  async status(): Promise<string> {
    const r = this.#c.repo;
    return this.#ssh(
      [
        "uptime | sed 's/.*load/load/'",
        "free -g | awk 'NR==2{print \"memory: \" $7 \" GB available of \" $2}'",
        "docker ps --filter name=laya- --format '{{.Names}}: {{.Status}}'",
        `echo "series: $(${this.#seriesProcesses} | sed 's/.*cli.ts series //' | tr '\\n' ' ')"`,
        `for f in ${r}/lab/logs/lane-*.log; do [ -f "$f" ] && awk -v f="$(basename $f)" '/^### /{n=0; h=$0} /^result:/{n++; last=$0} END{print f ": " n " results since " h "; last " last}' "$f"; done`,
        `echo "runs there: $(ls ${r}/runs | wc -l)"`,
      ].join("; "),
    );
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
    if ((await this.#ssh(this.#seriesProcesses)).trim()) {
      throw new Error(`${this.name} is running a series already (one GM account per arena server); stop it first`);
    }
    // The runner mounts the repo there: the code, tactics and templates go over first.
    for (const dir of ["bot/src", "tactics", "templates"]) {
      await this.#rsync("--delete", `${join(ROOT, dir)}/`, `${this.#c.host}:${this.#c.repo}/${dir}/`);
    }
    const local = seriesPath(o.series);
    const file = basename(local);
    await this.#ssh(`mkdir -p ${this.#c.repo}/lab/series ${this.#c.repo}/lab/logs`);
    await this.#rsync(local, `${this.#c.host}:${this.#c.repo}/lab/series/${file}`);
    const lane = o.lane ?? 0;
    const parallel = o.parallel ?? 8;
    const log = `/work/lab/logs/lane-${lane}.log`;
    await this.#ssh(
      `docker exec -d -e FLEET_INSTANCE=${this.name} -e FLEET_LANE=${lane} ${this.#runner} sh -c ` +
        `"cd /work/bot && echo '### $(date -u +%FT%TZ) ${file}' >> ${log} && exec node src/cli.ts series ../lab/series/${file} --parallel ${parallel} >> ${log} 2>&1"`,
    );
    return `started ${file} on lane ${lane} (${parallel} arenas)`;
  }

  async stop(): Promise<string> {
    const pids = (await this.#ssh(this.#seriesProcesses)).split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
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

  async #cell(action: string, body: string, timeoutMs = 300_000): Promise<string> {
    await mkdir(join(CACHE, this.name), { recursive: true });
    const file = join(CACHE, this.name, `cell-${action}.py`);
    const code = `# fleet ${this.name}: ${action}\ndef _fleet():\n${PY_HELPERS.replace(/^/gm, "    ")}\n${body.replace(/^/gm, "    ")}\n_fleet()\n`;
    await writeFile(file, code);
    const bridge = this.#c.bridge.map((a) => a.replace(/^~(?=\/)/, homedir()));
    const out = await run("colab-bridge", [...bridge, "run", file], timeoutMs);
    const at = out.lastIndexOf("FLEET>>>");
    if (at < 0) {
      throw new Error(`no answer from ${this.name}:\n${out.slice(-1500)}`);
    }
    return out.slice(at + "FLEET>>>".length).trim();
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
    running = sh(f"pgrep -fa 'arena-series-{i} '")
    total = ""
    m = re.search(r"series (\\S+\\.json)", running)
    if m and os.path.exists(m.group(1)):
        total = f"/{len(json.load(open(m.group(1))))}"
    model = servers.get(8001 + i, (0, "no Laya server"))[1]
    lines.append(f"lane {i} [{model}]: {'running' if running else 'idle'}, {len(results)}{total} entries done {('(' + head + ')') if head else ''}; last: {results[-1] if results else '-'}")
lines.append(f"runs there: {len(glob.glob(A + '/nvm/runs/*.json'))}")
print("FLEET>>>" + "\\n".join(lines))`,
    );
  }

  async pull(): Promise<string> {
    const shipped = await this.#cell(
      "ship",
      `import gzip, shutil
from google.colab import userdata
from huggingface_hub import HfApi
A, name, repo = ${JSON.stringify(this.#dir)}, ${JSON.stringify(this.name)}, ${JSON.stringify(this.#c.runsRepo)}
ship = f"{A}/ship"
os.makedirs(ship, exist_ok=True)
done_file = f"{A}/shipped.txt"
shipped = set(open(done_file).read().split()) if os.path.exists(done_file) else set()
new = []
for f in sorted(glob.glob(f"{A}/nvm/runs/*.json")):
    base = os.path.basename(f)
    if base in shipped:
        continue
    try:
        json.load(open(f))
    except ValueError:
        continue
    target = base if base.startswith(name + "--") else f"{name}--{base}"
    with open(f, "rb") as src, gzip.open(f"{ship}/{target}.gz", "wb") as dst:
        shutil.copyfileobj(src, dst)
    new.append(base)
if new:
    api = HfApi(token=userdata.get("HF_TOKEN"))
    api.create_repo(repo, repo_type="dataset", private=True, exist_ok=True)
    api.upload_folder(repo_id=repo, repo_type="dataset", folder_path=ship, path_in_repo=name, allow_patterns=["*.gz"], commit_message=f"{name}: {len(new)} runs")
    with open(done_file, "a") as fh:
        fh.write("\\n".join(new) + "\\n")
    for g in glob.glob(f"{ship}/*.gz"):
        os.remove(g)
print(f"FLEET>>>{len(new)}")`,
      900_000,
    );
    const hf = existsSync(join(ROOT, ".laya", "venv", "bin", "hf")) ? join(ROOT, ".laya", "venv", "bin", "hf") : "hf";
    const cache = join(CACHE, "hf", this.#c.runsRepo.replace("/", "--"));
    await run(hf, ["download", this.#c.runsRepo, "--repo-type", "dataset", "--include", `${this.name}/*`, "--local-dir", cache, "--quiet"], 900_000);
    return `${shipped} runs shipped, ${await importRuns(join(cache, this.name), this.name)} new here`;
  }

  async start(o: StartOptions): Promise<string> {
    const lane = o.lane ?? 0;
    const local = seriesPath(o.series);
    const file = basename(local);
    const entries = await readFile(local, "utf8");
    JSON.parse(entries); // fail here, not there
    return this.#cell(
      "start",
      `A, name, lane, model = ${JSON.stringify(this.#dir)}, ${JSON.stringify(this.name)}, ${lane}, ${JSON.stringify(o.model ?? "")}
if sh(f"pgrep -f 'arena-series-{lane} '"):
    print(f"FLEET>>>lane {lane} is busy; stop it first"); return
os.makedirs(f"{A}/series", exist_ok=True)
path = f"{A}/series/${file}"
with open(path, "w") as fh:
    fh.write(${JSON.stringify(entries)})
said = []
port = 8001 + lane
if model and laya_servers().get(port, (0, ""))[1] != model:
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
                break
        except Exception:
            pass
        time.sleep(2)
    else:
        print(f"FLEET>>>the Laya server for {model} did not come up; see {A}/laya-{port}.log"); return
    said.append(f"lane {lane} now plays {model}")
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
    const pattern = lane === undefined ? "arena-series-[0-9]" : `arena-series-${lane} `;
    return this.#cell("stop", `sh(${JSON.stringify(`pkill -f '${pattern}'`)})\nprint("FLEET>>>stopped " + ${JSON.stringify(lane === undefined ? "every lane" : `lane ${lane}`)})`);
  }

  async logs(lane = 0, lines = 40): Promise<string> {
    return this.#cell("logs", `print("FLEET>>>" + sh(${JSON.stringify(`tail -n ${Math.min(lines, 500)} ${this.#dir}/lane-${lane}.series.log`)}))`);
  }
}
