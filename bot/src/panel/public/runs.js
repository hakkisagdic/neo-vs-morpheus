// Runs page: every recorded match, newest first, with its score, arena, question version,
// decision times and run checks; a row opens its replay.
import { $, esc } from "./util.js";

let runs = [];

export async function showRuns(filter = "") {
  if (filter) $("runs-filter").value = filter;
  if (!runs.length) {
    $("runs-body").innerHTML = `<tr><td colspan="9" class="muted">reading the runs…</td></tr>`;
  }
  runs = await (await fetch("/api/runs")).json();
  render();
}

const fighter = (f) =>
  `<span class="brain-${esc(f.brain)}">${esc(f.name)}</span> <span class="muted">${esc(f.brain)}` +
  `${f.template && f.template !== "mage" ? ` · ${esc(f.template)}` : ""}${f.tactics && f.tactics !== "neutral" ? ` · ${esc(f.tactics)}` : ""}</span>`;

function score(r) {
  const best = Math.max(0, ...Object.values(r.wins));
  const parts = r.fighters.map((f) => {
    const n = r.wins[f.name] ?? 0;
    return `<span class="${n === best && n > 0 ? "win" : ""}">${esc(f.name)} ${n}</span>`;
  });
  return parts.join(" · ") + (r.draws ? ` · <span class="muted">${r.draws} draw${r.draws > 1 ? "s" : ""}</span>` : "");
}

function render() {
  const q = $("runs-filter").value.trim().toLowerCase();
  const clean = $("runs-clean").checked;
  const rows = runs.filter(
    (r) => (!clean || !r.problems.length) && (!q || JSON.stringify([r.title, r.fighters, r.arena, r.file, r.versions?.models]).toLowerCase().includes(q)),
  );
  $("runs-count").textContent = `${rows.length} of ${runs.length} runs`;
  $("runs-body").innerHTML = rows
    .map((r) => {
      const started = new Date(r.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const models = r.fighters
        .filter((f) => f.brain !== "rules" && r.latencyMs[f.name] !== undefined)
        .map((f) => `${esc(f.name)} ${r.latencyMs[f.name]} ms`)
        .join("<br>");
      const question = r.versions?.mage ? `${esc(r.versions.mage.question)}<br><span class="muted">${esc(r.versions.mage.describe)}</span>` : "—";
      const checks = r.problems.length
        ? `<span class="badge warn" title="${esc(r.problems.join("\n"))}">not comparable</span>`
        : `<span class="badge ok">clean</span>`;
      return (
        `<tr data-file="${esc(r.file)}"><td>${started}</td><td>${r.fighters.map(fighter).join("<br>")}</td><td>${score(r)}</td>` +
        `<td>${r.rounds}</td><td>${r.avgRoundS} s</td><td>${r.arena ? `${esc(r.arena)} · ${r.distance}` : "—"}</td>` +
        `<td>${question}</td><td>${models || "—"}</td><td>${checks}</td></tr>`
      );
    })
    .join("");
}

$("runs-filter").addEventListener("input", render);
$("runs-clean").addEventListener("change", render);
$("runs-body").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-file]");
  if (tr) location.hash = `#/replay/${encodeURIComponent(tr.dataset.file)}`;
});
