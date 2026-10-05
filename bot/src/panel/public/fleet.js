// Fleet page: every machine at a glance (lanes, models, load), today's numbers and results by
// matchup. A machine card opens its lanes; a result row opens the matching runs. The browser keeps
// the last snapshot, so the page shows it at once and swaps in the fresh one when it arrives.
import { $, esc } from "./util.js";

const CACHE_KEY = "fleet:last";
/** A lane idle this long is a retired one (the keeper restarts a planned lane within minutes): listed, not counted. */
const STALE_MS = 30 * 60_000;

let timer = null;
let active = false;
let loading = false;
let failed = false;
let data = null;
let open = null;

export async function showFleet() {
  active = true;
  if (!data) {
    data = cached();
    if (data) render();
    else skeleton();
  }
  await load();
}

export function hideFleet() {
  active = false;
  clearTimeout(timer);
}

function cached() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
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
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch {
      // private window or full storage: the page works without the copy
    }
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

function skeleton() {
  const bar = (w) => `<span class="skeleton" style="width:${w}"></span>`;
  $("fleet-kpis").innerHTML = ["lanes running", "runs today", "rounds today", "Laya at matched speed"]
    .map((k) => `<div class="kpi"><div class="kpi-v">${bar("70px")}</div><div class="kpi-k">${k}</div></div>`)
    .join("");
  $("fleet-cards").innerHTML = ["mac", "alastyr", "kaggle", "camber"]
    .map((name) => `<article class="card machine"><h2><span class="led"></span>${name}</h2><div class="big">${bar("120px")}</div><div>${bar("85%")}</div><div>${bar("60%")}</div></article>`)
    .join("");
  $("fleet-results").innerHTML = `<tr><td colspan="5" class="muted"><span class="spinner"></span>reading today's runs</td></tr>`;
}

const pct = (a, b) => (a + b ? Math.round((100 * a) / (a + b)) : 0);
const laya = (side) => /^neo-duel|^laya /.test(side);
const stale = (l) => !l.running && l.updatedAt && Date.now() - l.updatedAt > STALE_MS;

/**
 * The headline duel: a checkpoint's own play (no tactics) as a mage against the scripted mage at
 * matched speed (rules@60 or quicker), the best share among those with 40 rounds or more.
 */
function matchedSpeed(rows) {
  const best = { model: null, wins: 0, losses: 0 };
  for (const r of rows) {
    const i = r.sides.findIndex(laya);
    const quick = /^rules@(\d+) mage$/.exec(r.sides[1 - i] ?? "");
    if (i < 0 || !quick || Number(quick[1]) > 60 || !/^\S+ mage$/.test(r.sides[i])) continue;
    const [w, l] = [r.wins[i], r.wins[1 - i]];
    if (w + l >= 40 && pct(w, l) > pct(best.wins, best.losses)) Object.assign(best, { model: r.sides[i].split(" ")[0], wins: w, losses: l });
  }
  return best;
}

function render() {
  const lanes = data.instances.flatMap((m) => m.lanes).filter((l) => !stale(l));
  const running = lanes.filter((l) => l.running).length;
  const runsToday = Object.values(data.runsToday).reduce((a, b) => a + b, 0);
  const rounds = data.results.reduce((n, r) => n + r.wins[0] + r.wins[1] + r.draws, 0);
  const best = matchedSpeed(data.results);
  $("fleet-kpis").innerHTML = [
    ["lanes running", `${running}<small> of ${lanes.length}</small>`],
    ["runs today", runsToday],
    ["rounds today", rounds],
    ["Laya at matched speed", best.model ? `${pct(best.wins, best.losses)}%<small> ${esc(best.model)} · ${best.wins}–${best.losses}</small>` : "—"],
  ]
    .map(([k, v]) => `<div class="kpi"><div class="kpi-v">${v}</div><div class="kpi-k">${k}</div></div>`)
    .join("");

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

  const m = data.instances.find((x) => x.name === open);
  $("fleet-detail").hidden = !m;
  if (m) {
    $("fleet-detail-title").textContent = `${m.name}: lanes`;
    $("fleet-lanes").innerHTML = m.lanes.length
      ? m.lanes
          .map((l) => {
            const state = l.running ? "running" : stale(l) ? `idle since ${new Date(l.updatedAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "idle";
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

  $("fleet-results").innerHTML = data.results.length
    ? data.results
        .map((r) => {
          const p = pct(r.wins[0], r.wins[1]);
          const q = r.sides.find(laya)?.split(" ")[0] ?? r.sides[0].split(" ")[0];
          return (
            `<tr data-q="${esc(q)}"><td>${esc(r.sides[0])}</td><td class="score">${r.wins[0]}–${r.wins[1]}${r.draws ? ` <span class="muted">+${r.draws}</span>` : ""}</td>` +
            `<td><span class="gauge split"><i style="width:${p}%"></i></span> ${p}%</td><td>${esc(r.sides[1])}</td>` +
            `<td class="muted">${r.runs} runs${r.flagged ? ` · <span title="runs a run check flagged (slow decisions, late casts, a silent model) are not counted">${r.flagged} flagged, left out</span>` : ""}</td></tr>`
          );
        })
        .join("")
    : `<tr><td colspan="5" class="muted">no runs today yet</td></tr>`;
  status();
}

$("fleet-cards").addEventListener("click", (e) => {
  const card = e.target.closest(".machine[data-name]");
  if (!card || !data) return;
  open = open === card.dataset.name ? null : card.dataset.name;
  render();
});

$("fleet-results").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-q]");
  if (tr) location.hash = `#/runs/${encodeURIComponent(tr.dataset.q)}`;
});
