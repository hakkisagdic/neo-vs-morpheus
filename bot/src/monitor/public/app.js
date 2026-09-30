// Duel monitor page: follows one bot's decisions live and draws the arena.

const $ = (id) => document.getElementById(id);
const state = {
  decisions: [],
  log: [],
  live: { bots: {} },
  match: null,
  follow: null,
  selected: null,
  followingLive: true,
  connected: false,
  effects: [],
};

const SPELL_CIRCLE = {
  "Magic Arrow": 1, Heal: 1, Weaken: 1, Clumsy: 1, Feeblemind: 1,
  Harm: 2, Cure: 2, Protection: 2,
  Poison: 3, Teleport: 3, Fireball: 3,
  Curse: 4, Lightning: 4, "Greater Heal": 4,
  Paralyze: 5, "Mind Blast": 5,
  Explosion: 6, "Energy Bolt": 6,
  Flamestrike: 7,
};
const SPELL_COLOR = {
  explosion: "#ff8a3d", flamestrike: "#ff5a2b", lightning: "#9fd8ff", poison: "#6be675",
  harm: "#ff4d6d", magicArrow: "#ffe08a", curse: "#b98cff", paralyze: "#c9a7ff", weaken: "#d58cff",
  heal: "#3ecf8e", greaterHeal: "#3ecf8e", cure: "#7cf0c0", teleport: "#8fd3ff",
};
const castMs = (name) => (2 + (SPELL_CIRCLE[name] ?? 3)) * 250;
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// Fighters' plans named as their options ("attack:secondary", "heal:bandage", ...).
const MELEE_OPTION = { attack: (p) => p.ability ?? "swing", bandage: () => "bandage", drink: () => "potion", throw: () => "explosion", retreat: () => "retreat" };
const spellOf = (d) =>
  d.module === "melee"
    ? (MELEE_OPTION[d.plan.kind]?.(d.plan) ?? d.plan.kind)
    : d.plan.kind === "cast" ? d.plan.spell : d.plan.kind === "teleport" ? "teleport" : d.plan.kind;
const modeOf = (d) =>
  d.module === "melee"
    ? d.mode.choice
    : d.plan.kind === "cast" || d.plan.kind === "teleport" ? d.mode.choice : d.plan.kind === "retreat" ? "defense" : "wait";
const probOf = (d) => d.parts?.[d.mode.choice]?.probabilities?.[spellOf(d)];

// ---------------------------------------------------------------- connection

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
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
  $("live").textContent = on ? "● live" : "○ offline";
}

function handle(msg) {
  switch (msg.type) {
    case "hello":
      state.decisions = msg.decisions ?? [];
      state.log = msg.log ?? [];
      state.match = msg.match;
      state.follow ??= state.decisions.at(-1)?.bot ?? msg.match?.fighters?.[0]?.name ?? null;
      renderAll();
      break;
    case "decision":
      state.decisions.push(msg.record);
      if (state.decisions.length > 600) state.decisions.shift();
      state.follow ??= msg.record.bot;
      renderAll();
      break;
    case "outcome": {
      const i = state.decisions.findLastIndex((d) => d.bot === msg.record.bot && d.id === msg.record.id);
      if (i >= 0) state.decisions[i] = msg.record;
      spawnEffect(msg.record);
      renderAll();
      break;
    }
    case "log":
      state.log.push(msg);
      damageFloater(msg);
      break;
    case "live":
      state.live = msg;
      state.follow ??= Object.keys(msg.bots)[0] ?? null;
      renderTabs();
      renderStatus();
      break;
    case "match":
      state.match = msg.match;
      renderMatch();
      break;
  }
}

// ---------------------------------------------------------------- rendering

function mine() {
  return state.decisions.filter((d) => d.bot === state.follow);
}

function current() {
  const list = mine();
  if (!state.followingLive && state.selected) {
    return list.find((d) => d.id === state.selected) ?? list.at(-1);
  }
  return list.at(-1);
}

function renderAll() {
  renderTabs();
  renderHeader();
  renderLog();
  renderDecision();
  renderMatch();
}

function renderTabs() {
  const names = Object.keys(state.live.bots ?? {});
  for (const d of state.decisions) if (!names.includes(d.bot)) names.push(d.bot);
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
  $("them").textContent = d?.opponent ?? state.live.bots?.[state.follow]?.them?.name ?? "—";
  $("meta").textContent = d
    ? ` #${d.id} · ${fmtTime(d.at)} · ${d.latencyMs.toFixed(1)} ms · ${d.inputTokens} in / ${d.outputTokens} out · ${d.model}`
    : "";
}

function renderLog() {
  const list = mine();
  const sel = current();
  $("decisions").innerHTML = list
    .slice(-200)
    .reverse()
    .map((d) => {
      const failed = d.outcome && !["cast", "moved", "waited"].includes(d.outcome.result);
      return `<li data-id="${d.id}" class="${d === sel ? "selected" : ""}"><span class="t">${fmtTime(d.at)}</span> <span class="m-${modeOf(d)}">${modeOf(d)}</span>/${esc(spellOf(d))}${failed ? ` <span class="fail">✗ ${esc(d.outcome.result)}</span>` : ""}</li>`;
    })
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
  const order =
    d.module === "melee"
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
  const b = state.live.bots?.[state.follow];
  if (!b) return;
  const now = state.live.at ?? Date.now();
  const us = b.us;
  const them = b.them;
  let casting = "ready";
  if (b.casting) casting = `casting ${b.casting.spell}`;
  else if (b.readyAt > now) casting = `recovering ${us.lastSpell ?? ""} — free in ${((b.readyAt - now) / 1000).toFixed(1)} s`;
  $("us-name").textContent = us.name;
  $("us").innerHTML = [
    ["health", meter("hp", us.hits, us.hitsMax, `${us.hits}/${us.hitsMax} (${Math.round((100 * us.hits) / (us.hitsMax || 1))}%)`)],
    ["mana", meter("mana", us.mana, us.manaMax, `${us.mana}/${us.manaMax}`)],
    ["poisoned", us.poisoned ? `<span class="m-damage">yes</span>` : "no"],
    ["casting", esc(casting)],
    ["position", `${us.x},${us.y}`],
  ].map(([k, v]) => `<div class="row"><span class="label">${k}</span><span>${v}</span></div>`).join("");
  $("them-name").textContent = them.name;
  $("themStatus").innerHTML = [
    ["health", meter("hp", them.healthPct, 100, them.dead ? "dead" : `${them.healthPct}%`)],
    ["poisoned", them.poisoned ? `<span class="m-damage">yes</span>` : "no"],
    ["casting", them.casting ? `<span class="m-interrupt">${esc(them.casting)}</span> · lands in ${(them.landsInMs / 1000).toFixed(1)} s` : "not casting"],
    ["distance", `${them.distance} tiles`],
    ["LOS", String(them.inLineOfSight)],
    ["in range", String(them.inRange)],
  ].map(([k, v]) => `<div class="row"><span class="label">${k}</span><span>${v}</span></div>`).join("");
}

function percentile(values, q) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function renderMatch() {
  const m = state.match;
  $("match-title").textContent = m ? m.title : "";
  const byBot = {};
  for (const d of state.decisions) (byBot[d.bot] ??= []).push(d);
  const cells = Object.entries(byBot).map(([bot, list]) => {
    const lat = list.map((d) => d.latencyMs);
    const casts = list.filter((d) => d.outcome?.result === "cast").length;
    const fails = list.filter((d) => d.outcome && !["cast", "moved", "waited"].includes(d.outcome.result)).length;
    return `<div><div class="lbl">${esc(bot)} · ${esc(list.at(-1).brain)}</div><div class="big">${list.length} decisions</div><div>p50 ${percentile(lat, 0.5).toFixed(0)} ms · p95 ${percentile(lat, 0.95).toFixed(0)} ms</div><div>${casts} cast · ${fails} failed</div></div>`;
  });
  const wins = {};
  for (const r of m?.results ?? []) if (r.winner) wins[r.winner] = (wins[r.winner] ?? 0) + 1;
  const score = m ? `<div><div class="lbl">round</div><div class="big">${m.round} / ${m.rounds}</div><div>${Object.entries(wins).map(([k, v]) => `${esc(k)} ${v}`).join(" · ") || "no result yet"}</div></div>` : "";
  const rounds = m?.results?.length
    ? `<div class="rounds">${m.results.map((r) => `#${r.round} <span class="w">${esc(r.winner ?? "draw")}</span> (${esc(r.reason)}, ${(r.durationMs / 1000).toFixed(0)} s)`).join(" · ")}</div>`
    : "";
  $("match").innerHTML = score + cells.join("") + rounds;
}

// ---------------------------------------------------------------- arena

const canvas = $("arena");
const ctx = canvas.getContext("2d");

function fighters() {
  const out = new Map();
  for (const [name, b] of Object.entries(state.live.bots ?? {})) {
    out.set(name, {
      name, x: b.us.x, y: b.us.y, hp: (100 * b.us.hits) / (b.us.hitsMax || 1), poisoned: b.us.poisoned,
      dead: b.us.hits <= 0, casting: b.casting, bot: true,
    });
  }
  for (const b of Object.values(state.live.bots ?? {})) {
    const t = b.them;
    if (t && !out.has(t.name)) {
      out.set(t.name, {
        name: t.name, x: t.x, y: t.y, hp: t.healthPct, poisoned: t.poisoned, dead: t.dead,
        casting: t.casting ? { spell: t.casting, since: Date.now() - t.castingForMs } : null, bot: false,
      });
    }
  }
  return out;
}

function spawnEffect(rec) {
  if (!rec.outcome || rec.outcome.result !== "cast") return;
  const spell = rec.plan.kind === "teleport" ? "teleport" : rec.plan.spell;
  state.effects.push({
    from: rec.bot, to: rec.plan.kind === "cast" && rec.plan.target === "self" ? rec.bot : rec.opponent,
    tile: rec.plan.kind === "teleport" ? rec.plan.tile : null, spell, start: performance.now(),
  });
}

function damageFloater(msg) {
  const m = /^(.+) took (\d+) damage$/.exec(msg.text);
  if (m) state.effects.push({ floater: `-${m[2]}`, on: m[1], start: performance.now() });
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const fs = fighters();
  const list = [...fs.values()];
  const cx = list.length ? list.reduce((s, f) => s + f.x, 0) / list.length : 0;
  const cy = list.length ? list.reduce((s, f) => s + f.y, 0) / list.length : 0;
  const span = Math.max(18, ...list.map((f) => Math.abs(f.x - cx) * 2 + 8));
  const tile = w / span;
  const px = (x) => w / 2 + (x - cx) * tile;
  const py = (y) => h / 2 + (y - cy) * tile;

  // grid
  ctx.strokeStyle = "#1a212b";
  ctx.lineWidth = 1;
  const x0 = Math.floor(cx - w / tile / 2) - 1;
  const y0 = Math.floor(cy - h / tile / 2) - 1;
  for (let x = x0; x < x0 + w / tile + 3; x++) {
    ctx.beginPath();
    ctx.moveTo(px(x - 0.5), 0);
    ctx.lineTo(px(x - 0.5), h);
    ctx.stroke();
  }
  for (let y = y0; y < y0 + h / tile + 3; y++) {
    ctx.beginPath();
    ctx.moveTo(0, py(y - 0.5));
    ctx.lineTo(w, py(y - 0.5));
    ctx.stroke();
  }
  $("arena-note").textContent = list.length ? `Felucca · ${Math.round(cx)},${Math.round(cy)} · ${list.length} fighters` : "no fighters yet";

  const now = performance.now();
  // spell effects
  state.effects = state.effects.filter((e) => now - e.start < 1100);
  for (const e of state.effects) {
    const t = (now - e.start) / 700;
    if (e.floater) {
      const f = fs.get(e.on);
      if (!f) continue;
      ctx.globalAlpha = Math.max(0, 1 - (now - e.start) / 1100);
      ctx.fillStyle = "#ff6b7a";
      ctx.font = `bold ${Math.max(12, tile * 0.45)}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.fillText(e.floater, px(f.x) + tile * 0.6, py(f.y) - tile * 0.9 - (now - e.start) / 40);
      ctx.globalAlpha = 1;
      continue;
    }
    const a = fs.get(e.from);
    const b = e.tile ? { x: e.tile.x, y: e.tile.y } : fs.get(e.to);
    if (!a || !b || t > 1.4) continue;
    const color = SPELL_COLOR[e.spell] ?? "#ffffff";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (e.from === e.to) {
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(px(a.x), py(a.y), tile * (0.5 + t * 0.8), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      const k = Math.min(1, t);
      const x = px(a.x) + (px(b.x) - px(a.x)) * k;
      const y = py(a.y) + (py(b.y) - py(a.y)) * k;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 2;
      ctx.setLineDash(e.spell === "teleport" ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(px(a.x), py(a.y));
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(3, tile * 0.16), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // fighters
  for (const f of list) {
    const x = px(f.x);
    const y = py(f.y);
    const r = Math.max(6, tile * 0.32);
    const me = f.name === state.follow;
    ctx.fillStyle = f.dead ? "#39414d" : me ? "#5aa9ff" : f.bot ? "#ff5d6c" : "#8f7cff";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (f.poisoned) {
      ctx.strokeStyle = "#6be675";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    // health bar
    const bw = Math.max(34, tile * 1.4);
    ctx.fillStyle = "#1b212b";
    ctx.fillRect(x - bw / 2, y - r - 14, bw, 5);
    ctx.fillStyle = f.hp < 35 ? "#ff5d6c" : "#3ecf8e";
    ctx.fillRect(x - bw / 2, y - r - 14, (bw * Math.max(0, f.hp)) / 100, 5);
    // name
    ctx.fillStyle = "#cdd6e0";
    ctx.font = "12px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(f.dead ? `${f.name} ✝` : f.name, x, y - r - 18);
    // casting
    if (f.casting && !f.dead) {
      const p = Math.min(1, (Date.now() - f.casting.since) / castMs(f.casting.spell));
      ctx.strokeStyle = "#e062b8";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 5, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#e062b8";
      ctx.fillText(f.casting.spell, x, y + r + 16);
    }
  }
  requestAnimationFrame(draw);
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

connect();
requestAnimationFrame(draw);
