// Fleet page: every machine at a glance (a card opens its lanes, and on this Mac its resource
// report), the training jobs, and the models' scoreboard against the scripted bot at matched speed
// (a cell opens its runs). The browser keeps the last snapshot, so the page shows it at once and
// swaps in the fresh one when it arrives.
import { $, esc } from "./util.js";

const CACHE_KEY = "fleet:last";
const RANGE_KEY = "fleet:range";
/** A lane idle this long is a retired one (the keeper restarts a planned lane within minutes): listed, not counted. */
const STALE_MS = 30 * 60_000;
/** Fewer rounds than this do not settle a share. */
const SETTLED_ROUNDS = 40;

let timer = null;
let machineTimer = null;
let active = false;
let loading = false;
let failed = false;
let data = null;
let open = null;
let range = stored(RANGE_KEY) === "week" ? "week" : "today";

export async function showFleet() {
  active = true;
  if (!data) {
    data = cached();
    if (data?.scoreboard) render();
    else skeleton();
  }
  await load();
}

export function hideFleet() {
  active = false;
  clearTimeout(timer);
  clearInterval(machineTimer);
}

function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private window or full storage: the page works without the copy
  }
}

function cached() {
  try {
    return JSON.parse(stored(CACHE_KEY) ?? "null");
  } catch {
    return null;
  }
}

async function load() {
  clearTimeout(timer);
  loading = true;
  status();
  let next = 30_000;
  try {
    const res = await fetch("/api/fleet");
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
    failed = false;
    store(CACHE_KEY, JSON.stringify(data));
    render();
    // The server answered with what it had and is building a newer snapshot: ask again soon.
    if (data.refreshing) next = 4_000;
  } catch {
    failed = true;
    next = 10_000;
  } finally {
    loading = false;
    status();
    if (active) timer = setTimeout(load, next);
  }
}

function status() {
  const busy = loading || data?.refreshing;
  const when = data ? `updated ${new Date(data.at).toLocaleTimeString()}` : "reading the machines";
  const note = failed ? ` · <span class="warn-text">the panel cannot reach the fleet; retrying</span>` : busy ? (data ? " · refreshing" : "") : " · refreshes every 30 s";
  $("fleet-updated").innerHTML = `${busy ? `<span class="spinner"></span>` : ""}${when}${note}`;
}

const bar = (w) => `<span class="skeleton" style="width:${w}"></span>`;

function skeleton() {
  $("fleet-kpis").innerHTML = ["lanes running", "runs today", "rounds today", "Laya at matched speed"]
    .map((k) => `<div class="kpi"><div class="kpi-v">${bar("70px")}</div><div class="kpi-k">${k}</div></div>`)
    .join("");
  $("fleet-cards").innerHTML = ["mac", "alastyr", "kaggle", "camber"]
    .map((name) => `<article class="card machine"><h2><span class="led"></span>${name}</h2><div class="big">${bar("120px")}</div><div>${bar("85%")}</div><div>${bar("60%")}</div></article>`)
    .join("");
  $("fleet-training").innerHTML = `<tr><td colspan="7" class="muted"><span class="spinner"></span>reading the training jobs</td></tr>`;
  $("score-head").innerHTML = "";
  $("score-body").innerHTML = `<tr><td class="muted"><span class="spinner"></span>reading the runs</td></tr>`;
  $("score-collection").textContent = "";
  renderRange();
}

const pct = (a, b) => (a + b ? Math.round((100 * a) / (a + b)) : 0);
const stale = (l) => !l.running && l.updatedAt && Date.now() - l.updatedAt > STALE_MS;
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (ms) => (new Date(ms).toDateString() === new Date().toDateString() ? clock(ms) : new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }));
const rows = (rs) => rs.wins + rs.losses + rs.draws;

/** The headline: today's best checkpoint in the mage duel (its own play, no profile), once settled. */
function headline() {
  let best = null;
  for (const row of data.scoreboard.today.rows) {
    const c = row.cells.mage;
    if (!row.tactics && c && rows(c) >= SETTLED_ROUNDS && (!best || pct(c.wins, c.losses) > pct(best.c.wins, best.c.losses))) best = { model: row.model, c };
  }
  return best;
}

function render() {
  renderKpis();
  renderCards();
  renderDetail();
  renderTraining();
  renderScoreboard();
  status();
}

function renderKpis() {
  const lanes = data.instances.flatMap((m) => m.lanes).filter((l) => !stale(l));
  const running = lanes.filter((l) => l.running).length;
  const runsToday = Object.values(data.runsToday).reduce((a, b) => a + b, 0);
  const best = headline();
  $("fleet-kpis").innerHTML = [
    ["lanes running", `${running}<small> of ${lanes.length}</small>`],
    ["runs today", runsToday],
    ["rounds today", data.roundsToday],
    ["Laya at matched speed", best ? `${pct(best.c.wins, best.c.losses)}%<small> ${esc(best.model)} · mage · ${best.c.wins}–${best.c.losses}</small>` : "—"],
  ]
    .map(([k, v]) => `<div class="kpi"><div class="kpi-v">${v}</div><div class="kpi-k">${k}</div></div>`)
    .join("");
}

function renderCards() {
  $("fleet-cards").innerHTML = data.instances
    .map((m) => {
      const current = m.lanes.filter((l) => !stale(l));
      const on = current.filter((l) => l.running).length;
      const state = !m.ok ? "err" : on ? "on" : "idle";
      const models = [...new Set(current.map((l) => l.model).filter(Boolean))];
      return (
        `<article class="card machine ${state} ${open === m.name ? "open" : ""}" data-name="${esc(m.name)}">` +
        `<h2><span class="led ${state}"></span>${esc(m.name)} <small>${esc(m.kind)}</small></h2>` +
        `<div class="big">${m.ok ? `${on}<small> of ${current.length} lanes running</small>` : "unreachable"}</div>` +
        `<div class="muted">${m.ok ? m.summary.map(esc).join("<br>") : esc(m.error ?? "")}</div>` +
        `<div class="models">${models.map((x) => `<span class="badge">${esc(x)}</span>`).join(" ")}</div>` +
        `<div class="muted">${data.runsToday[m.name] ?? 0} runs today</div></article>`
      );
    })
    .join("");
}

function renderDetail() {
  const m = data.instances.find((x) => x.name === open);
  $("fleet-detail").hidden = !m;
  const mac = m?.kind === "mac";
  $("fleet-machine").hidden = !mac;
  clearInterval(machineTimer);
  if (mac) {
    loadMachine();
    machineTimer = setInterval(loadMachine, 10_000);
  }
  if (!m) return;
  $("fleet-detail-title").textContent = `${m.name}: lanes${mac ? " and resources" : ""}`;
  $("fleet-lanes").innerHTML = m.lanes.length
    ? m.lanes
        .map((l) => {
          const state = l.running ? "running" : stale(l) ? `idle since ${day(l.updatedAt)}` : "idle";
          return (
            `<tr class="${stale(l) ? "muted" : ""}"><td>${l.lane}</td><td><span class="led ${l.running ? "on" : "idle"}"></span>${state}</td>` +
            `<td>${esc(l.model ?? "—")}</td><td>${esc(l.series ?? "—")}</td>` +
            `<td>${l.done}${l.total ? ` / ${l.total} <span class="gauge"><i style="width:${Math.min(100, (100 * l.done) / l.total)}%"></i></span>` : ""}</td>` +
            `<td class="muted">${esc(l.last ?? "—")}</td></tr>`
          );
        })
        .join("")
    : `<tr><td colspan="6" class="muted">no lanes</td></tr>`;
}

async function loadMachine() {
  const pre = $("fleet-machine");
  if (!pre.textContent) pre.innerHTML = `<span class="spinner"></span>reading this Mac's resources`;
  try {
    pre.textContent = (await (await fetch("/api/machine")).json()).report;
  } catch {
    pre.textContent = "the panel cannot read the machine report";
  }
}

const WHERE = { mac: "this Mac (Metal)", kaggle: "Kaggle (2 × T4)" };

function renderTraining() {
  const jobs = data.training ?? [];
  $("fleet-training").innerHTML = jobs.length
    ? jobs
        .map((j) => {
          const on = j.state === "running" || j.state === "queued";
          const progress = j.epochs
            ? `epoch ${j.epoch} / ${j.epochs} <span class="gauge"><i style="width:${(100 * j.epoch) / j.epochs}%"></i></span>`
            : j.where === "kaggle" && on
              ? `<span class="muted">its log comes when it ends</span>`
              : j.epoch === 0 && on
                ? "first epoch"
                : "—";
          const agreement = j.before !== undefined ? `${j.before.toFixed(3)}${j.agreement !== undefined ? ` → ${j.agreement.toFixed(3)}` : ""}` : "—";
          const done = on
            ? j.etaAt
              ? `≈ ${day(j.etaAt)}`
              : j.where === "mac"
                ? `<span class="muted">known after the first epoch</span>`
                : "—"
            : j.state === "complete"
              ? j.home ? "done, on this Mac" : "done, not fetched yet"
              : esc(j.state);
          return (
            `<tr><td>${esc(j.name)}</td><td>${WHERE[j.where] ?? esc(j.where)}</td>` +
            `<td><span class="led ${on ? "on" : j.state === "error" ? "err" : "idle"}"></span>${esc(j.state)}</td>` +
            `<td>${progress}</td><td>${agreement}</td><td>${j.startedAt ? day(j.startedAt) : "—"}</td><td>${done}</td></tr>`
          );
        })
        .join("")
    : `<tr><td colspan="7" class="muted">no training in the last 36 hours</td></tr>`;
}

function renderRange() {
  for (const b of $("score-range").querySelectorAll("button")) b.classList.toggle("on", b.dataset.range === range);
}

function cell(row, column) {
  const c = row.cells[column];
  if (!c || !c.runs) return `<td class="muted">${c?.flagged ? `${c.flagged} flagged` : "—"}</td>`;
  const p = pct(c.wins, c.losses);
  const few = rows(c) < SETTLED_ROUNDS;
  return (
    `<td class="cell${few ? " few" : ""}" data-q="${esc(row.model)}" title="${few ? `fewer than ${SETTLED_ROUNDS} rounds: not settled yet` : ""}">` +
    `<span class="gauge split"><i style="width:${p}%"></i></span> <b>${p}%</b> <span class="muted">${c.wins}–${c.losses}${c.draws ? ` +${c.draws}` : ""}</span>` +
    `<div class="muted small">${c.runs} runs${c.flagged ? ` · ${c.flagged} flagged, left out` : ""}</div></td>`
  );
}

function renderScoreboard() {
  renderRange();
  const board = data.scoreboard[range];
  $("score-head").innerHTML = `<tr><th>model</th>${board.columns.map((c) => `<th>${esc(c === "mage" || c === "dexer" || c === "archer" ? `${c} duel` : c)}</th>`).join("")}</tr>`;
  $("score-body").innerHTML = board.rows.length
    ? board.rows
        .map((row) => `<tr><td>${esc(row.model)}${row.tactics ? ` <span class="badge">${esc(row.tactics)}</span>` : ""}</td>${board.columns.map((c) => cell(row, c)).join("")}</tr>`)
        .join("")
    : `<tr><td class="muted">no checkpoint played the scripted bot at matched speed ${range === "today" ? "today" : "in the last 7 days"}</td></tr>`;
  const LABEL = { exploration: "exploration (random moves, for learning)", scripted: "the scripted bot against itself", other: "other games" };
  const parts = board.collection.map(
    (c) =>
      `${LABEL[c.kind]}: ${c.runs} runs · ${c.rounds} rounds${c.models.length ? ` (${c.models.map(esc).join(", ")})` : ""}` +
      `${c.flagged ? ` · ${c.flagged} flagged` : ""}`,
  );
  $("score-collection").innerHTML = parts.length ? `<b>Data collection</b>, not counted above: ${parts.join(" · ")}` : "";
}

$("fleet-cards").addEventListener("click", (e) => {
  const card = e.target.closest(".machine[data-name]");
  if (!card || !data) return;
  open = open === card.dataset.name ? null : card.dataset.name;
  $("fleet-machine").textContent = "";
  renderCards();
  renderDetail();
});

$("score-range").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-range]");
  if (!b) return;
  range = b.dataset.range;
  store(RANGE_KEY, range);
  if (data?.scoreboard) renderScoreboard();
  else renderRange();
});

$("score-body").addEventListener("click", (e) => {
  const td = e.target.closest("td[data-q]");
  if (td) location.hash = `#/runs/${encodeURIComponent(td.dataset.q)}`;
});
