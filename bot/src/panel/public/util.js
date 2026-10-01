// Helpers shared by the panel's views.

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

// Fighters' plans named as their options ("attack:secondary", "heal:bandage", ...).
const MELEE_OPTION = { attack: (p) => p.ability ?? "swing", bandage: () => "bandage", drink: (p) => `${p.potion} potion`, throw: () => "explosion", retreat: () => "retreat" };
export const spellOf = (d) =>
  d.module === "melee"
    ? (MELEE_OPTION[d.plan.kind]?.(d.plan) ?? d.plan.kind)
    : d.plan.kind === "cast" ? d.plan.spell : d.plan.kind === "teleport" ? "teleport" : d.plan.hold ? "hold" : d.plan.kind;
export const modeOf = (d) =>
  d.module === "melee"
    ? d.mode.choice
    : d.plan.kind === "cast" || d.plan.kind === "teleport" ? d.mode.choice : d.plan.kind === "retreat" || d.plan.hold ? "defense" : "wait";

/** Results that mean the move was carried out; anything else (disturbed, blocked, refused, ...) failed. */
const DONE = new Set(["cast", "moved", "waited", "swinging", "closing", "kiting", "used"]);
export const failed = (d) => !!d.outcome && !DONE.has(d.outcome.result);

/** The followed fighter is blue; the others take the next colours. */
export const FIGHTER_COLORS = ["#5aa9ff", "#ff5d6c", "#8f7cff", "#e3a93b"];

/** "magicArrow" -> "Magic Arrow", the name the arena times casts by. */
export const spellName = (key) => key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
