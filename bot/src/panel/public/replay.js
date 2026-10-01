// Replay page: a recorded run round by round on the arena, with both sides' decisions. Every
// decision carries the state it was made in, so positions, health and casts come from those
// snapshots; between two decisions the fighter is drawn where it stood at the earlier one.
import { Arena, castMs } from "./arena.js";
import { $, FIGHTER_COLORS, esc, failed, modeOf, spellName, spellOf } from "./util.js";

const arena = new Arena($("replay-arena"), $("replay-note"));
let file = "";
let run = null;
let rounds = [];
let round = 0;
let t = 0;
let playing = false;
let last = 0;
let raf = 0;
let shown = -1;

/** Records split into rounds at the largest gaps in time: the setup between rounds. */
function splitRounds(records, n) {
  if (n <= 1 || records.length < 2) return [records];
  const cuts = records
    .slice(1)
    .map((r, i) => ({ i: i + 1, gap: r.at - records[i].at }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, n - 1)
    .map((g) => g.i)
    .sort((a, b) => a - b);
  return [0, ...cuts].map((start, k) => records.slice(start, cuts[k] ?? records.length));
}

export async function showReplay(f) {
  if (!f) {
    $("replay-title").textContent = "pick a run on the Runs page";
    return;
  }
  if (f !== file) {
    file = f;
    $("replay-title").textContent = "loading…";
    run = await (await fetch(`/api/runs/${encodeURIComponent(f)}`)).json();
    rounds = splitRounds([...run.records].sort((a, b) => a.at - b.at), run.match.results.length);
    $("replay-title").textContent = `${run.match.title} · ${new Date(run.match.startedAt).toLocaleString()}`;
    $("replay-round").innerHTML = rounds
      .map((_, i) => {
        const res = run.match.results[i];
        return `<option value="${i}">round ${i + 1}${res ? ` · ${esc(res.winner ?? "draw")} (${esc(res.reason)}, ${Math.round(res.durationMs / 1000)} s)` : ""}</option>`;
      })
      .join("");
    seekRound(0);
  }
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
}

export function hideReplay() {
  playing = false;
  updatePlay();
  cancelAnimationFrame(raf);
  raf = 0;
}

const records = () => rounds[round] ?? [];
const startAt = () => records()[0]?.at ?? 0;
const duration = () => (records().length ? records().at(-1).at - startAt() + 2_000 : 0);

function seekRound(i) {
  round = i;
  $("replay-round").value = String(i);
  t = 0;
  shown = -1;
  arena.reset();
  renderDecisions();
  const res = run?.match.results[i];
  $("replay-result").textContent = res ? `round ${i + 1}: ${res.winner ?? "draw"} (${res.reason}, ${Math.round(res.durationMs / 1000)} s, health ${JSON.stringify(res.healthPct)})` : "";
}

/** Each bot's latest record at or before `at`. */
function latestAt(at) {
  const out = new Map();
  for (const r of records()) {
    if (r.at > at) break;
    out.set(r.bot, r);
  }
  return out;
}

function fighters(at) {
  const latest = latestAt(at);
  const names = [...new Set(records().map((r) => r.bot))];
  const out = [];
  for (const [bot, r] of latest) {
    const us = r.snapshot.us;
    const plan = r.decision.plan;
    const castFor = r.outcome?.castMs ?? (plan.kind === "cast" ? castMs(spellName(plan.spell)) : 0);
    const casting = plan.kind === "cast" && at < r.at + castFor ? { spell: spellName(plan.spell), since: r.at } : null;
    out.push({
      name: bot, x: us.x, y: us.y, hp: (100 * us.hits) / (us.hitsMax || 1), poisoned: us.poisoned, dead: us.hits <= 0,
      casting, color: FIGHTER_COLORS[names.indexOf(bot) % FIGHTER_COLORS.length],
    });
  }
  // An opponent that recorded nothing (an NPC, a person) is drawn from what the bot saw.
  for (const r of latest.values()) {
    const them = r.snapshot.them;
    if (!out.some((f) => f.name === them.name)) {
      const i = names.indexOf(them.name);
      const color = FIGHTER_COLORS[i >= 0 ? i % FIGHTER_COLORS.length : 2];
      out.push({ name: them.name, x: them.x, y: them.y, hp: them.healthPct, poisoned: them.poisoned, dead: them.dead, casting: null, color });
    }
  }
  return out;
}

function renderDecisions() {
  $("replay-decisions").innerHTML = records()
    .map((r, i) => {
      const d = { ...r.decision, outcome: r.outcome };
      const s = ((r.at - startAt()) / 1000).toFixed(1);
      return `<li data-i="${i}"><span class="t">${s} s</span> ${esc(r.bot)} <span class="m-${modeOf(d)}">${modeOf(d)}</span>/${esc(spellOf(d))}${failed(d) ? ` <span class="fail">✗ ${esc(d.outcome.result)}</span>` : ""}</li>`;
    })
    .join("");
}

function tick(now) {
  const dt = now - last;
  last = now;
  const before = t;
  if (playing) {
    t = Math.min(duration(), t + dt * Number($("replay-speed").value));
    if (t >= duration()) {
      playing = false;
      updatePlay();
    }
  }
  const at = startAt() + t;
  // Spells cast since the last frame fly again.
  for (const r of records()) {
    const rel = r.at - startAt();
    if (rel > t) break;
    if (rel > before && t - before < 2_000 && r.outcome?.result === "cast") {
      const plan = r.decision.plan;
      const self = plan.kind === "cast" && plan.target === "self";
      arena.missile(r.bot, self ? r.bot : r.snapshot.them.name, plan.kind === "teleport" ? "teleport" : plan.spell, plan.kind === "teleport" ? plan.tile : null);
    }
  }
  const fs = fighters(at);
  arena.track(fs, at);
  arena.draw(fs, run?.match.obstacles ?? [], at);
  if (!$("replay-time").matches(":active")) {
    $("replay-time").value = String(duration() ? Math.round((1000 * t) / duration()) : 0);
  }
  $("replay-clock").textContent = `${(t / 1000).toFixed(1)} s / ${(duration() / 1000).toFixed(1)} s`;
  // Highlight the latest decision.
  let i = -1;
  for (const [k, r] of records().entries()) {
    if (r.at > at) break;
    i = k;
  }
  if (i !== shown) {
    $("replay-decisions").querySelector(".selected")?.classList.remove("selected");
    const li = $("replay-decisions").querySelector(`li[data-i="${i}"]`);
    li?.classList.add("selected");
    li?.scrollIntoView({ block: "nearest" });
    shown = i;
  }
  raf = requestAnimationFrame(tick);
}

function updatePlay() {
  $("replay-play").textContent = playing ? "❚❚ pause" : "▶ play";
  $("replay-play").classList.toggle("on", playing);
}

$("replay-play").addEventListener("click", () => {
  if (t >= duration()) t = 0;
  playing = !playing;
  updatePlay();
});
$("replay-round").addEventListener("change", (e) => seekRound(Number(e.target.value)));
$("replay-time").addEventListener("input", (e) => {
  t = (Number(e.target.value) / 1000) * duration();
  arena.reset();
});
$("replay-decisions").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  t = records()[Number(li.dataset.i)].at - startAt();
  arena.reset();
});
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !$("view-replay").hidden && e.target === document.body) {
    e.preventDefault();
    $("replay-play").click();
  }
});
