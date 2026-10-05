// Fleet page: every machine at a glance (lanes, models, load), today's numbers and results by
// matchup. A machine card opens its lanes; a result row opens the matching runs.
import { $, esc } from "./util.js";

let timer = null;
let data = null;
let open = null;

export async function showFleet() {
  clearInterval(timer);
  await load();
  timer = setInterval(load, 30_000);
}

export function hideFleet() {
  clearInterval(timer);
}

async function load() {
  try {
    data = await (await fetch("/api/fleet")).json();
  } catch {
    $("fleet-updated").textContent = "the panel cannot reach the fleet";
    return;
  }
  render();
}

const pct = (a, b) => (a + b ? Math.round((100 * a) / (a + b)) : 0);
const laya = (side) => /^neo-duel|^laya /.test(side);

/** The best checkpoint against the scripted bot at matched speed (rules@60 or quicker), exploration left out. */
function matchedSpeed(rows) {
  const best = { model: null, wins: 0, losses: 0 };
  for (const r of rows) {
    const i = r.sides.findIndex(laya);
    const other = r.sides[1 - i];
    const quick = /^rules@(\d+) /.exec(other ?? "");
    if (i < 0 || !quick || Number(quick[1]) > 60 || r.sides[i].includes(" explore")) continue;
    const [w, l] = [r.wins[i], r.wins[1 - i]];
    if (w + l >= 40 && pct(w, l) > pct(best.wins, best.losses)) Object.assign(best, { model: r.sides[i], wins: w, losses: l });
  }
  return best;
}

function render() {
  const lanes = data.instances.flatMap((m) => m.lanes);
  const running = lanes.filter((l) => l.running).length;
  const runsToday = Object.values(data.runsToday).reduce((a, b) => a + b, 0);
  const rounds = data.results.reduce((n, r) => n + r.wins[0] + r.wins[1] + r.draws, 0);
  const best = matchedSpeed(data.results);
  $("fleet-kpis").innerHTML = [
    ["lanes running", `${running}<small> / ${lanes.length}</small>`],
    ["runs today", runsToday],
    ["rounds today", rounds],
    ["Laya at matched speed", best.model ? `${pct(best.wins, best.losses)}%<small> ${esc(best.model.split(" ")[0])} · ${best.wins}–${best.losses}</small>` : "—"],
  ]
    .map(([k, v]) => `<div class="kpi"><div class="kpi-v">${v}</div><div class="kpi-k">${k}</div></div>`)
    .join("");

  $("fleet-cards").innerHTML = data.instances
    .map((m) => {
      const on = m.lanes.filter((l) => l.running).length;
      const state = !m.ok ? "err" : on ? "on" : "idle";
      const models = [...new Set(m.lanes.map((l) => l.model).filter(Boolean))];
      return (
        `<article class="card machine ${state} ${open === m.name ? "open" : ""}" data-name="${esc(m.name)}">` +
        `<h2><span class="led ${state}"></span>${esc(m.name)} <small>${esc(m.kind)}</small></h2>` +
        `<div class="big">${m.ok ? `${on}<small> / ${m.lanes.length} lanes running</small>` : "unreachable"}</div>` +
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
          .map(
            (l) =>
              `<tr><td>${l.lane}</td><td><span class="led ${l.running ? "on" : "idle"}"></span>${l.running ? "running" : "idle"}</td>` +
              `<td>${esc(l.model ?? "—")}</td><td>${esc(l.series ?? "—")}</td>` +
              `<td>${l.done}${l.total ? ` / ${l.total}` : ""}${l.total ? ` <span class="meter"><i style="width:${Math.min(100, (100 * l.done) / l.total)}%"></i></span>` : ""}</td>` +
              `<td class="muted">${esc(l.last ?? "—")}</td></tr>`,
          )
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
            `<td><span class="meter split"><i style="width:${p}%"></i></span> ${p}%</td><td>${esc(r.sides[1])}</td>` +
            `<td class="muted">${r.runs} runs${r.flagged ? ` · <span title="runs a run check flagged (slow decisions, late casts) are not counted">${r.flagged} flagged, left out</span>` : ""}</td></tr>`
          );
        })
        .join("")
    : `<tr><td colspan="5" class="muted">no runs today yet</td></tr>`;
  $("fleet-updated").textContent = `updated ${new Date(data.at).toLocaleTimeString()} · refreshes every 30 s`;
}

$("fleet-cards").addEventListener("click", (e) => {
  const card = e.target.closest(".machine");
  if (!card) return;
  open = open === card.dataset.name ? null : card.dataset.name;
  render();
});

$("fleet-results").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-q]");
  if (tr) location.hash = `#/runs/${encodeURIComponent(tr.dataset.q)}`;
});
