// Laya's training jobs for the panel: fine-tunes on this Mac's GPU (training/finetune.py, logging
// to .fleet/train/<name>.log) and on Kaggle (kernels "<name>-train", started by training/kaggle.py),
// with their progress where it can be seen. A Kaggle kernel shows its log only when it ends.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const LOGS = join(ROOT, ".fleet", "train");
const CHECKPOINTS = join(ROOT, "training", "checkpoints");
/** Jobs started longer ago than this are left out. */
const RECENT_MS = 36 * 3600_000;

export type TrainingJob = {
  name: string;
  where: "mac" | "kaggle";
  state: "running" | "queued" | "complete" | "stopped" | "error" | "unknown";
  startedAt?: number;
  /** Epochs done and planned, while the log is in sight. */
  epoch?: number;
  epochs?: number;
  /** When the last epoch should end, at the pace of the epochs so far. */
  etaAt?: number;
  /** Held-out agreement with the teacher before training and after the newest epoch. */
  before?: number;
  agreement?: number;
  /** The checkpoint is on this Mac (for a Kaggle job: fetched). */
  home: boolean;
};

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout: 60_000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))),
  );

const home = (name: string) => existsSync(join(CHECKPOINTS, name, "rl_agent_config.json"));

/**
 * What a training log tells so far. An epoch line reads "epoch 2/4: train soft CE … | held-out
 * agreement 0.612, soft CE 1.234 (5321 s)", the seconds counted from the start of training.
 */
export function readTrainingLog(text: string): { epoch: number; epochs?: number; seconds?: number; before?: number; agreement?: number; saved: boolean } {
  const lines = text.replace(/\r/g, "\n").split("\n");
  const epochs = lines.flatMap((l) => {
    const m = /^epoch (\d+)\/(\d+):.*held-out agreement ([\d.]+).*\((\d+) s\)/.exec(l);
    return m ? [{ epoch: Number(m[1]), epochs: Number(m[2]), agreement: Number(m[3]), seconds: Number(m[4]) }] : [];
  });
  const before = lines.map((l) => /^before: held-out agreement with teacher ([\d.]+)/.exec(l)).find(Boolean);
  const last = epochs.at(-1);
  return {
    epoch: last?.epoch ?? 0,
    epochs: last?.epochs,
    seconds: last?.seconds,
    before: before ? Number(before[1]) : undefined,
    agreement: last?.agreement,
    saved: lines.some((l) => l.startsWith("saved ")),
  };
}

/** Fine-tunes on this Mac: one log per job in .fleet/train, the process found by its output folder. */
async function macJobs(): Promise<TrainingJob[]> {
  const processes = await run("pgrep", ["-lf", "finetune.py"]).catch(() => "");
  const jobs: TrainingJob[] = [];
  for (const file of (await readdir(LOGS).catch(() => [] as string[])).filter((f) => f.endsWith(".log"))) {
    const name = file.slice(0, -".log".length);
    const st = await stat(join(LOGS, file));
    if (Date.now() - st.mtimeMs > RECENT_MS) {
      continue;
    }
    const log = readTrainingLog(await readFile(join(LOGS, file), "utf8"));
    const line = processes.split("\n").find((l) => l.includes(`checkpoints/${name} `) || l.endsWith(`checkpoints/${name}`));
    const epochs = log.epochs ?? (Number(/--epochs (\d+)/.exec(line ?? "")?.[1]) || undefined);
    // The newest epoch line is the log's last change: its time and its seconds give the pace.
    const etaAt = line && log.epoch && epochs && log.seconds ? st.mtimeMs + ((epochs - log.epoch) * log.seconds * 1000) / log.epoch : undefined;
    jobs.push({
      name,
      where: "mac",
      state: line ? "running" : log.saved ? "complete" : "stopped",
      startedAt: st.birthtimeMs || undefined,
      epoch: log.epoch,
      epochs,
      etaAt,
      before: log.before,
      agreement: log.agreement,
      home: home(name),
    });
  }
  return jobs;
}

/** Kaggle kernels named "<name>-train" that ran lately, with their state. */
async function kaggleJobs(): Promise<TrainingJob[]> {
  const csv = await run("kaggle", ["kernels", "list", "--mine", "--page-size", "20", "--csv"]).catch(() => "");
  const recent = csv
    .split("\n")
    .slice(1)
    .map((line) => line.split(","))
    .filter(([ref, , , at]) => ref?.endsWith("-train") && at && Date.now() - Date.parse(`${at.replace(" ", "T")}Z`) < RECENT_MS);
  return Promise.all(
    recent.map(async ([ref, , , at]) => {
      const out = await run("kaggle", ["kernels", "status", ref]).catch((err: Error) => err.message);
      const state = out.match(/status "?(?:KernelWorkerStatus\.)?(\w+)/)?.[1]?.toLowerCase() ?? "unknown";
      const name = ref.split("/")[1].replace(/-train$/, "");
      return {
        name,
        where: "kaggle" as const,
        state: (["running", "queued", "complete", "error"].includes(state) ? state : "unknown") as TrainingJob["state"],
        startedAt: Date.parse(`${at.replace(" ", "T")}Z`),
        home: home(name),
      };
    }),
  );
}

/** Every recent training job, the running ones first, then the newest. */
export async function trainingJobs(): Promise<TrainingJob[]> {
  const jobs = (await Promise.all([macJobs(), kaggleJobs()])).flat();
  const order = (j: TrainingJob) => (j.state === "running" || j.state === "queued" ? 0 : 1);
  return jobs.sort((a, b) => order(a) - order(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
