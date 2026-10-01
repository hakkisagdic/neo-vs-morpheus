// Arena drawing shared by the live view and replays: fighters, walls and pillars, the paths of
// the last seconds, spells in flight and damage, under a camera that keeps every fighter in view
// on both axes (kiting takes fighters far from the arena's centre, in any direction).

const SPELL_CIRCLE = {
  "Magic Arrow": 1, Heal: 1, Weaken: 1, Clumsy: 1, Feeblemind: 1,
  Harm: 2, Cure: 2, Protection: 2,
  Poison: 3, Teleport: 3, Fireball: 3,
  Curse: 4, Lightning: 4, "Greater Heal": 4,
  Paralyze: 5, "Mind Blast": 5, "Magic Reflection": 5,
  Explosion: 6, "Energy Bolt": 6,
  Flamestrike: 7,
};
export const SPELL_COLOR = {
  explosion: "#ff8a3d", flamestrike: "#ff5a2b", lightning: "#9fd8ff", poison: "#6be675", energyBolt: "#7aa2ff",
  mindBlast: "#f5a3ff", harm: "#ff4d6d", magicArrow: "#ffe08a", curse: "#b98cff", paralyze: "#c9a7ff",
  weaken: "#d58cff", heal: "#3ecf8e", greaterHeal: "#3ecf8e", cure: "#7cf0c0", teleport: "#8fd3ff",
  protection: "#e3a93b", magicReflection: "#e3a93b",
};
/** Cast time from a spell's display name: (2 + circle) x 250 ms. */
export const castMs = (name) => (2 + (SPELL_CIRCLE[name] ?? 3)) * 250;

const TRAIL_MS = 12_000;
const lerp = (a, b, k) => a + (b - a) * k;

export class Arena {
  /** @param {HTMLCanvasElement} canvas @param {HTMLElement} [note] */
  constructor(canvas, note) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.note = note;
    this.cam = null;
    this.effects = [];
    this.trails = new Map();
  }

  /** Adds where each fighter stands at `at` to its path; points older than 12 s fall off. */
  track(fighters, at) {
    for (const f of fighters) {
      const t = this.trails.get(f.name) ?? [];
      const last = t.at(-1);
      if (last && at < last.at) {
        t.length = 0; // time went back: a replay was rewound
      }
      if (!last || last.x !== f.x || last.y !== f.y) {
        t.push({ x: f.x, y: f.y, at });
      }
      while (t.length && at - t[0].at > TRAIL_MS) {
        t.shift();
      }
      this.trails.set(f.name, t);
    }
  }

  reset() {
    this.trails.clear();
    this.effects = [];
    this.cam = null;
  }

  /** A spell from one fighter to another (or to a tile, or to itself). */
  missile(from, to, spell, tile = null) {
    this.effects.push({ from, to, spell, tile, start: performance.now() });
  }

  floater(on, text) {
    this.effects.push({ floater: text, on, start: performance.now() });
  }

  /**
   * @param fighters [{name, x, y, hp, poisoned, dead, casting: {spell, since} | null, color}]
   * @param obstacles [{x, y}]
   * @param castClock the clock casting.since is measured on (Date.now() live, replay time in replays)
   */
  draw(fighters, obstacles = [], castClock = Date.now()) {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) {
      return;
    }
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!fighters.length) {
      if (this.note) this.note.textContent = "no fighters yet";
      return;
    }

    // Camera: the fighters and the walls close to them in view. Paths are drawn but do not widen
    // it: a long chase would otherwise shrink the fighters to dots.
    let minX = Math.min(...fighters.map((p) => p.x));
    let maxX = Math.max(...fighters.map((p) => p.x));
    let minY = Math.min(...fighters.map((p) => p.y));
    let maxY = Math.max(...fighters.map((p) => p.y));
    const near = obstacles.filter((o) => o.x >= minX - 10 && o.x <= maxX + 10 && o.y >= minY - 10 && o.y <= maxY + 10);
    for (const o of near) {
      minX = Math.min(minX, o.x);
      maxX = Math.max(maxX, o.x);
      minY = Math.min(minY, o.y);
      maxY = Math.max(maxY, o.y);
    }
    const tile = Math.max(5, Math.min(56, w / Math.max(14, maxX - minX + 6), h / Math.max(9, maxY - minY + 6)));
    const target = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, tile };
    const k = this.cam ? 0.12 : 1;
    this.cam = {
      cx: lerp(this.cam?.cx ?? target.cx, target.cx, k),
      cy: lerp(this.cam?.cy ?? target.cy, target.cy, k),
      tile: lerp(this.cam?.tile ?? target.tile, target.tile, k),
    };
    const { cx, cy } = this.cam;
    const T = this.cam.tile;
    const px = (x) => w / 2 + (x - cx) * T;
    const py = (y) => h / 2 + (y - cy) * T;

    // grid
    ctx.strokeStyle = "#1a212b";
    ctx.lineWidth = 1;
    const x0 = Math.floor(cx - w / T / 2) - 1;
    const y0 = Math.floor(cy - h / T / 2) - 1;
    for (let x = x0; x < x0 + w / T + 3; x++) {
      ctx.beginPath();
      ctx.moveTo(px(x - 0.5), 0);
      ctx.lineTo(px(x - 0.5), h);
      ctx.stroke();
    }
    for (let y = y0; y < y0 + h / T + 3; y++) {
      ctx.beginPath();
      ctx.moveTo(0, py(y - 0.5));
      ctx.lineTo(w, py(y - 0.5));
      ctx.stroke();
    }

    // walls and pillars
    ctx.fillStyle = "#3a4555";
    ctx.strokeStyle = "#566377";
    for (const o of obstacles) {
      const x = px(o.x - 0.5);
      const y = py(o.y - 0.5);
      if (x > -T && x < w && y > -T && y < h) {
        ctx.fillRect(x + 1, y + 1, T - 2, T - 2);
        ctx.strokeRect(x + 1, y + 1, T - 2, T - 2);
      }
    }

    // paths of the last seconds
    const color = new Map(fighters.map((f) => [f.name, f.color]));
    for (const [name, t] of this.trails) {
      if (t.length < 2 || !color.has(name)) continue;
      ctx.strokeStyle = color.get(name);
      ctx.lineWidth = Math.max(1.5, T * 0.08);
      for (let i = 1; i < t.length; i++) {
        ctx.globalAlpha = 0.08 + 0.4 * (i / t.length);
        ctx.beginPath();
        ctx.moveTo(px(t[i - 1].x), py(t[i - 1].y));
        ctx.lineTo(px(t[i].x), py(t[i].y));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    const byName = new Map(fighters.map((f) => [f.name, f]));
    const now = performance.now();
    this.effects = this.effects.filter((e) => now - e.start < 1100);
    for (const e of this.effects) {
      const t = (now - e.start) / 700;
      if (e.floater) {
        const f = byName.get(e.on);
        if (!f) continue;
        ctx.globalAlpha = Math.max(0, 1 - (now - e.start) / 1100);
        ctx.fillStyle = "#ff6b7a";
        ctx.font = `bold ${Math.max(12, T * 0.45)}px ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.fillText(e.floater, px(f.x) + T * 0.6, py(f.y) - T * 0.9 - (now - e.start) / 40);
        ctx.globalAlpha = 1;
        continue;
      }
      const a = byName.get(e.from);
      const b = e.tile ? { x: e.tile.x, y: e.tile.y } : byName.get(e.to);
      if (!a || !b || t > 1.4) continue;
      const c = SPELL_COLOR[e.spell] ?? "#ffffff";
      ctx.strokeStyle = c;
      ctx.fillStyle = c;
      if (e.from === e.to) {
        ctx.globalAlpha = Math.max(0, 1 - t);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(px(a.x), py(a.y), T * (0.5 + t * 0.8), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        const q = Math.min(1, t);
        const x = px(a.x) + (px(b.x) - px(a.x)) * q;
        const y = py(a.y) + (py(b.y) - py(a.y)) * q;
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
        ctx.arc(x, y, Math.max(3, T * 0.16), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (const f of fighters) {
      const x = px(f.x);
      const y = py(f.y);
      const r = Math.max(6, T * 0.32);
      ctx.fillStyle = f.dead ? "#39414d" : f.color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (f.poisoned) {
        ctx.strokeStyle = "#6be675";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      const bw = Math.max(34, T * 1.4);
      ctx.fillStyle = "#1b212b";
      ctx.fillRect(x - bw / 2, y - r - 14, bw, 5);
      ctx.fillStyle = f.hp < 35 ? "#ff5d6c" : "#3ecf8e";
      ctx.fillRect(x - bw / 2, y - r - 14, (bw * Math.max(0, f.hp)) / 100, 5);
      ctx.fillStyle = "#cdd6e0";
      ctx.font = "12px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(f.dead ? `${f.name} ✝` : f.name, x, y - r - 18);
      if (f.casting && !f.dead) {
        const p = Math.max(0, Math.min(1, (castClock - f.casting.since) / castMs(f.casting.spell)));
        ctx.strokeStyle = "#e062b8";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r + 5, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "#e062b8";
        ctx.fillText(f.casting.spell, x, y + r + 16);
      }
    }
    if (this.note) {
      const d = fighters.length === 2 ? Math.max(Math.abs(fighters[0].x - fighters[1].x), Math.abs(fighters[0].y - fighters[1].y)) : null;
      this.note.textContent = `${Math.round(cx)},${Math.round(cy)} · ${fighters.length} fighters${d !== null ? ` · ${d} tiles apart` : ""}`;
    }
  }
}
