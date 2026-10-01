// Control panel page: live matches (every duel publishing to the panel is a source), recorded
// runs, their replays and the machine's state, one view at a time (#/live, #/runs, #/replay/<file>,
// #/machine).
import { Arena } from "./arena.js";
import { showReplay, hideReplay } from "./replay.js";
import { showRuns } from "./runs.js";
import { $, FIGHTER_COLORS, esc, failed, fmtTime, modeOf, spellOf } from "./util.js";

const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
const probOf = (d) => d.parts?.[d.mode.choice]?.probabilities?.[spellOf(d)];

// ---------------------------------------------------------------- state

const state = {
  /** id -> { id, match, decisions, log, live, since } */
  sources: new Map(),
  source: null,
  follow: null,
  selected: null,
  followingLive: true,
  connected: false,
};
const arena = new Arena($("arena"), $("arena-note"));

const src = () => (state.source ? state.sources.get(state.source) : null);
const sourceOf = (id) => {
  let s = state.sources.get(id);
  if (!s) {
    s = { id, match: null, decisions: [], log: [], live: { bots: {} }, since: Date.now() };
    state.sources.set(id, s);
  }
  return s;
};

// ---------------------------------------------------------------- connection

let socket = null;

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => setConnected(true);
  ws.onclose = () => {
    setConnected(false);
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function setConnected(on) {
  state.connected = on;
  $("live").classList.toggle("on", on);
  $("live").textContent = on ? (state.sources.size ? "● live" : "● idle") : "○ offline";
}

function chooseSource(id) {
  if (state.source !== id) {
    state.source = id;
    state.follow = null;
    state.selected = null;
    arena.reset();
  }
}

function handle(msg) {
  if (msg.type === "hello") {
    state.sources.clear();
    for (const s of msg.sources ?? []) {
      state.sources.set(s.id, { ...s, live: { bots: {} } });
    }
    chooseSource([...state.sources.keys()].at(-1) ?? null);
    renderSources();
    renderAll();
    return;
  }
  if (!msg.source) return;
  if (msg.type === "gone") {
    state.sources.delete(msg.source);
    if (state.source === msg.source) chooseSource([...state.sources.keys()].at(-1) ?? null);
    renderSources();
    return;
  }
  const s = sourceOf(msg.source);
  if (!state.source || msg.type === "source") chooseSource(msg.source); // the newest match takes the screen
  switch (msg.type) {
    case "source":
      renderSources();
      break;
    case "decision":
      s.decisions.push(msg.record);
      if (s.decisions.length > 600) s.decisions.shift();
      if (s.id === state.source) {
        state.follow ??= msg.record.bot;
        renderAll();
      }
      break;
    case "outcome": {
      const i = s.decisions.findLastIndex((d) => d.bot === msg.record.bot && d.id === msg.record.id);
      if (i >= 0) s.decisions[i] = msg.record;
      if (s.id === state.source) {
        effect(msg.record);
        renderAll();
      }
      break;
    }
    case "log":
      s.log.push(msg);
      if (s.log.length > 200) s.log.shift();
      if (s.id === state.source) {
        const m = /^(.+) took (\d+) damage$/.exec(msg.text);
        if (m) arena.floater(m[1], `-${m[2]}`);
      }
      break;
    case "live":
      s.live = msg;
      if (s.id === state.source) {
        state.follow ??= Object.keys(msg.bots)[0] ?? null;
        arena.track(fighters(), Date.now());
        renderTabs();
        renderStatus();
        renderTactics();
      }
      break;
    case "match":
      s.match = msg.match;
      renderSources();
      if (s.id === state.source) renderMatch();
      break;
  }
}

function effect(rec) {
  if (!rec.outcome || rec.outcome.result !== "cast") return;
  const spell = rec.plan.kind === "teleport" ? "teleport" : rec.plan.spell;
  const self = rec.plan.kind === "cast" && rec.plan.target === "self";
  arena.missile(rec.bot, self ? rec.bot : rec.opponent, spell, rec.plan.kind === "teleport" ? rec.plan.tile : null);
}

// ---------------------------------------------------------------- live rendering

const mine = () => (src()?.decisions ?? []).filter((d) => d.bot === state.follow);

function current() {
  const list = mine();
  if (!state.followingLive && state.selected) {
    return list.find((d) => d.id === state.selected) ?? list.at(-1);
  }
  return list.at(-1);
}

function renderAll() {
  setConnected(state.connected);
  renderTabs();
  renderHeader();
  renderLog();
  renderDecision();
  renderMatch();
}

function renderSources() {
  const sel = $("source");
  const html = state.sources.size > 1
    ? [...state.sources.values()].map((s) => `<option value="${s.id}" ${s.id === state.source ? "selected" : ""}>${esc(s.match?.title ?? s.id)}</option>`).join("")
    : "";
  if (sel.dataset.html !== html) {
    sel.innerHTML = html;
    sel.dataset.html = html;
  }
}

function renderTabs() {
  const s = src();
  const names = Object.keys(s?.live.bots ?? {});
  for (const d of s?.decisions ?? []) if (!names.includes(d.bot)) names.push(d.bot);
  const tabs = $("tabs");
  const html = names.length > 1 ? names.map((n) => `<button data-bot="${esc(n)}" class="${n === state.follow ? "active" : ""}">${esc(n)}</button>`).join("") : "";
  if (tabs.dataset.html !== html) {
    tabs.innerHTML = html;
    tabs.dataset.html = html;
  }
}

function renderHeader() {
  const d = current();
  $("me").textContent = state.follow ?? "—";
  $("them").textContent = d?.opponent ?? src()?.live.bots?.[state.follow]?.them?.name ?? "—";
  $("meta").textContent = d
    ? ` #${d.id} · ${fmtTime(d.at)} · ${d.latencyMs.toFixed(1)} ms · ${d.inputTokens} in / ${d.outputTokens} out · ${d.model}`
    : "";
}

function renderLog() {
  const sel = current();
  $("decisions").innerHTML = mine()
    .slice(-200)
    .reverse()
    .map((d) => `<li data-id="${d.id}" class="${d === sel ? "selected" : ""}"><span class="t">${fmtTime(d.at)}</span> <span class="m-${modeOf(d)}">${modeOf(d)}</span>/${esc(spellOf(d))}${failed(d) ? ` <span class="fail">✗ ${esc(d.outcome.result)}</span>` : ""}</li>`)
    .join("");
}

function renderDecision() {
  const d = current();
  if (!d) return;
  const p = probOf(d);
  const tile = d.plan.kind === "teleport" ? d.plan.tile : null;
  const rows = [
    ["target", d.plan.kind === "cast" && d.plan.target === "self" ? `${esc(d.bot)} (self)` : hex(d.target)],
    tile ? ["tile", `${esc(tile.id)} @ ${tile.x},${tile.y}`] : null,
    ["why", esc(d.why)],
    d.overrides?.length ? ["guard", `<span class="override">${d.overrides.map(esc).join("<br>")}</span>`] : null,
    d.outcome ? ["result", `${esc(d.outcome.result)}${d.outcome.castMs ? ` · cast ${d.outcome.castMs} ms` : ""}`] : ["result", "…"],
    ["brain", `${esc(d.brain)} · ${d.latencyMs.toFixed(1)} ms`],
  ].filter(Boolean);
  $("decision").innerHTML =
    `<div class="headline"><span class="m-${modeOf(d)}">${modeOf(d)}</span> / ${esc(spellOf(d))}${p !== undefined ? `<span class="p">${p.toFixed(2)}</span>` : ""}</div>` +
    `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  bars("mode", d.mode);
  // Mages show their three spell lists; fighters their three most likely modes.
  const TITLES = { damage: "Damage spell", interrupt: "Interrupt spell", defense: "Defense spell" };
  const order = d.module === "melee"
    ? Object.entries(d.mode.probabilities).sort((a, b) => b[1] - a[1]).map(([m]) => m)
    : ["damage", "interrupt", "defense"];
  ["damage", "interrupt", "defense"].forEach((box, i) => {
    const m = order[i];
    $(`h-${box}`).textContent = TITLES[m] ?? (m ? m[0].toUpperCase() + m.slice(1) : "");
    if (m) bars(box, d.parts?.[m]);
    else $(box).innerHTML = "";
  });
}

function bars(id, dist) {
  if (!dist) return;
  const entries = Object.entries(dist.probabilities).sort((a, b) => b[1] - a[1]);
  $(id).innerHTML = entries
    .map(([k, v], i) => {
      const top = i === 0 ? "top" : "";
      return `<span class="name ${top}">${esc(k)}</span><span class="track ${top}"><span class="fill" style="width:${(v * 100).toFixed(1)}%"></span></span><span class="v">${Math.round(v * 100)}%</span>`;
    })
    .join("");
}

function meter(cls, value, max, text) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (100 * value) / max)) : 0;
  return `<div class="meter ${cls}${cls === "hp" && pct < 35 ? " low" : ""}"><div class="fill" style="width:${pct}%"></div><div class="txt">${text}</div></div>`;
}

function renderStatus() {
  const s = src();
  const b = s?.live.bots?.[state.follow];
  if (!b) return;
  const now = s.live.at ?? Date.now();
  const { us, them } = b;
  let casting = "ready";
  if (b.casting) casting = `casting ${b.casting.spell}`;
  else if (b.readyAt > now) casting = `recovering ${us.lastSpell ?? ""} — free in ${((b.readyAt - now) / 1000).toFixed(1)} s`;
  const row = ([k, v]) => `<div class="row"><span class="label">${k}</span><span>${v}</span></div>`;
  $("us-name").textContent = us.name;
  $("us").innerHTML = [
    ["health", meter("hp", us.hits, us.hitsMax, `${us.hits}/${us.hitsMax} (${Math.round((100 * us.hits) / (us.hitsMax || 1))}%)`)],
    ["mana", meter("mana", us.mana, us.manaMax, `${us.mana}/${us.manaMax}`)],
    ["stamina", `${us.stam}/${us.stamMax}`],
    ["poisoned", us.poisoned ? `<span class="m-damage">yes</span>` : "no"],
    ["casting", esc(casting)],
    us.weapon ? ["weapon", esc(us.weapon.name)] : null,
    us.protection ? ["buffs", "Protection"] : null,
    ["position", `${us.x},${us.y}`],
  ].filter(Boolean).map(row).join("");
  $("them-name").textContent = them.name;
  $("themStatus").innerHTML = [
    ["health", meter("hp", them.healthPct, 100, them.dead ? "dead" : `${them.healthPct}%`)],
    ["poisoned", them.poisoned ? `<span class="m-damage">yes</span>` : "no"],
    ["casting", them.casting ? `<span class="m-interrupt">${esc(them.casting)}</span> · lands in ${(them.landsInMs / 1000).toFixed(1)} s` : "not casting"],
    them.weapon ? ["weapon", esc(them.weapon)] : ["weapon", "none (a caster)"],
    them.protection ? ["buffs", "Protection"] : null,
    ["distance", `${them.distance} tiles`],
    ["sight", them.inLineOfSight ? "in sight" : "out of sight"],
  ].filter(Boolean).map(row).join("");
}

function percentile(values, q) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function renderMatch() {
  const m = src()?.match;
  $("match-title").textContent = m ? m.title : "";
  const byBot = {};
  for (const d of src()?.decisions ?? []) (byBot[d.bot] ??= []).push(d);
  const cells = Object.entries(byBot).map(([bot, list]) => {
    const lat = list.map((d) => d.latencyMs);
    const done = list.filter((d) => d.outcome && !failed(d)).length;
    const fails = list.filter((d) => failed(d)).length;
    return `<div><div class="lbl">${esc(bot)} · ${esc(list.at(-1).brain)}</div><div class="big">${list.length} decisions</div><div>p50 ${percentile(lat, 0.5).toFixed(0)} ms · p95 ${percentile(lat, 0.95).toFixed(0)} ms</div><div>${done} done · ${fails} failed</div></div>`;
  });
  const wins = {};
  for (const r of m?.results ?? []) if (r.winner) wins[r.winner] = (wins[r.winner] ?? 0) + 1;
  const where = m?.arena ? ` · ${esc(m.arena)}, ${m.distance} tiles` : "";
  const score = m ? `<div><div class="lbl">round${where}</div><div class="big">${m.round} / ${m.rounds}</div><div>${Object.entries(wins).map(([k, v]) => `${esc(k)} ${v}`).join(" · ") || "no result yet"}</div></div>` : "";
  const rounds = m?.results?.length
    ? `<div class="rounds">${m.results.map((r) => `#${r.round} <span class="w">${esc(r.winner ?? "draw")}</span> (${esc(r.reason)}, ${(r.durationMs / 1000).toFixed(0)} s)`).join(" · ")}</div>`
    : "";
  $("match").innerHTML = score + cells.join("") + rounds;
}

// ---------------------------------------------------------------- tactics

// The followed bot's tactics as editable fields. Bands are health percentages: under the floor
// that move is required, above the ceiling it is not offered, in between the model decides.
const TACTIC_FIELDS = [
  { key: "aggression", label: "aggression", kind: "range", min: -1, max: 1, step: 0.1, hint: "-1 cautious · +1 aggressive" },
  { key: "heal", label: "heal band %", kind: "band", hint: "heal under the floor · no heals above the ceiling" },
  { key: "retreat", label: "retreat band %", kind: "band" },
  { key: "chase.maxTiles", label: "chase up to (tiles)", kind: "number", min: 0, max: 60 },
  { key: "chase.giveUpSeconds", label: "give up a chase after (s)", kind: "number", min: 0, max: 600 },
  { key: "chase.teleport", label: "teleport when chasing", kind: "check" },
  { key: "kite", label: "keep from melee (tiles)", kind: "number", min: 0, max: 12, hint: "between attacks: an archer runs while reloading, a mage while it cannot cast · 0 off" },
  { key: "explore", label: "explore", kind: "range", min: 0, max: 0.5, step: 0.05, hint: "share of the model's decisions that try another legal move at random, for learning from outcomes · 0 off" },
  { key: "bandage", label: "bandage band %", kind: "band", module: "melee" },
  { key: "healPotion", label: "heal potion band %", kind: "band", module: "melee" },
  { key: "explosionRange", label: "throw explosions from (tiles)", kind: "band", module: "melee" },
];
const getPath = (o, path) => path.split(".").reduce((x, k) => x?.[k], o);
let shownTactics = "";

function renderTactics() {
  const b = src()?.live.bots?.[state.follow];
  if (!b?.tactics) return;
  const shown = `${state.source}|${state.follow}|${JSON.stringify(b.tactics)}`;
  // Re-render only when the values changed elsewhere, and never under the user's cursor.
  if (shown === shownTactics || $("tactics").contains(document.activeElement)) return;
  shownTactics = shown;
  const t = b.tactics;
  $("tactics-name").textContent = `${state.follow} · ${t.id}`;
  const field = (f) => {
    const v = getPath(t, f.key);
    const id = `t-${f.key.replace(".", "-")}`;
    const input =
      f.kind === "range"
        ? `<input id="${id}" type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${v}"><output>${v}</output>`
        : f.kind === "band"
          ? `<input id="${id}-lo" type="number" min="0" max="100" value="${v[0]}"> – <input id="${id}-hi" type="number" min="0" max="100" value="${v[1]}">`
          : f.kind === "check"
            ? `<input id="${id}" type="checkbox" ${v ? "checked" : ""}>`
            : `<input id="${id}" type="number" min="${f.min}" max="${f.max}" value="${v}">`;
    return `<div class="row"><span class="label" title="${esc(f.hint ?? "")}">${esc(f.label)}</span><span>${input}</span></div>`;
  };
  const matchups = Object.keys(t.vs ?? {});
  $("tactics").innerHTML =
    TACTIC_FIELDS.filter((f) => !f.module || f.module === b.module).map(field).join("") +
    (matchups.length ? `<p class="empty">the file also has settings for ${matchups.map(esc).join(", ")} opponents; values set here replace them</p>` : "");
  for (const el of $("tactics").querySelectorAll("input")) {
    el.addEventListener("change", sendTactics);
    if (el.type === "range") el.addEventListener("input", () => (el.nextElementSibling.textContent = el.value));
  }
}

function sendTactics() {
  const b = src()?.live.bots?.[state.follow];
  if (!b?.tactics || socket?.readyState !== WebSocket.OPEN) return;
  const t = structuredClone(b.tactics);
  for (const f of TACTIC_FIELDS) {
    const id = `t-${f.key.replace(".", "-")}`;
    let v;
    if (f.kind === "band") {
      const lo = $(`${id}-lo`);
      const hi = $(`${id}-hi`);
      if (!lo || !hi) continue;
      v = [Number(lo.value), Number(hi.value)];
    } else {
      const el = $(id);
      if (!el) continue;
      v = f.kind === "check" ? el.checked : Number(el.value);
    }
    const [head, tail] = f.key.split(".");
    if (tail) t[head][tail] = v;
    else t[head] = v;
  }
  socket.send(JSON.stringify({ type: "tactics", source: state.source, bot: state.follow, tactics: t }));
}

// ---------------------------------------------------------------- live arena

function fighters() {
  const bots = src()?.live.bots ?? {};
  const names = [...Object.keys(bots)];
  for (const b of Object.values(bots)) if (b.them && !names.includes(b.them.name)) names.push(b.them.name);
  const color = (name) => (name === state.follow ? FIGHTER_COLORS[0] : FIGHTER_COLORS[1 + (names.indexOf(name) % 3)]);
  const out = [];
  for (const [name, b] of Object.entries(bots)) {
    out.push({
      name, x: b.us.x, y: b.us.y, hp: (100 * b.us.hits) / (b.us.hitsMax || 1), poisoned: b.us.poisoned,
      dead: b.us.hits <= 0, casting: b.casting, color: color(name),
    });
  }
  for (const b of Object.values(bots)) {
    const t = b.them;
    if (t && !out.some((f) => f.name === t.name)) {
      out.push({
        name: t.name, x: t.x, y: t.y, hp: t.healthPct, poisoned: t.poisoned, dead: t.dead,
        casting: t.casting ? { spell: t.casting, since: Date.now() - t.castingForMs } : null, color: color(t.name),
      });
    }
  }
  return out;
}

function frame() {
  if (view === "live") arena.draw(fighters(), src()?.live.obstacles ?? []);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- views

let view = "live";
let machineTimer = null;

async function route() {
  const [, name = "live", ...rest] = location.hash.split("/");
  view = ["live", "runs", "replay", "machine"].includes(name) ? name : "live";
  for (const v of ["live", "runs", "replay", "machine"]) $(`view-${v}`).hidden = v !== view;
  for (const a of $("nav").querySelectorAll("a")) a.classList.toggle("active", a.dataset.view === view);
  // Live-only controls leave the bar on other views, so it stays one line and covers nothing.
  for (const id of ["title-live", "source", "tabs", "follow"]) $(id).style.display = view === "live" ? "" : "none";
  clearInterval(machineTimer);
  if (view !== "replay") hideReplay();
  if (view === "runs") await showRuns();
  if (view === "replay") await showReplay(decodeURIComponent(rest.join("/")));
  if (view === "machine") {
    const load = async () => ($("machine").textContent = (await (await fetch("/api/machine")).json()).report);
    await load();
    machineTimer = setInterval(load, 10_000);
  }
}

// ---------------------------------------------------------------- interaction

$("tabs").addEventListener("click", (e) => {
  const bot = e.target.dataset?.bot;
  if (bot) {
    state.follow = bot;
    state.selected = null;
    renderAll();
    renderStatus();
  }
});

$("source").addEventListener("change", (e) => {
  chooseSource(e.target.value);
  renderAll();
});

$("decisions").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  state.selected = Number(li.dataset.id);
  state.followingLive = false;
  $("follow").classList.remove("on");
  $("follow").textContent = "paused · resume live";
  renderAll();
});

$("follow").addEventListener("click", () => {
  state.followingLive = true;
  state.selected = null;
  $("follow").classList.add("on");
  $("follow").textContent = "following live";
  renderAll();
});

window.addEventListener("hashchange", route);
connect();
route();
requestAnimationFrame(frame);
