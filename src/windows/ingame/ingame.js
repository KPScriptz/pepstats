"use strict";

const els = {
  widget: document.getElementById("widget"),
  csm: document.getElementById("csm"),
  sparkLine: document.getElementById("spark-line"),
  sparkDot: document.getElementById("spark-dot"),
  gpm: document.getElementById("gpm"),
  visYou: document.getElementById("vis-you"),
  visOpp: document.getElementById("vis-opp"),
  kpYou: document.getElementById("kp-you"),
  kpOpp: document.getElementById("kp-opp"),
  kdaYou: document.getElementById("kda-you"),
  kdaOpp: document.getElementById("kda-opp"),
  lvlYou: document.getElementById("lvl-you"),
  lvlOpp: document.getElementById("lvl-opp"),
  status: document.getElementById("status"),
  timeline: document.getElementById("timeline"),
};

// Stat rows, toggled + reordered per lane.
const rows = {
  csm: document.getElementById("row-csm"),
  gpm: document.getElementById("row-gpm"),
  vision: document.getElementById("row-vision"),
  kp: document.getElementById("row-kp"),
  kda: document.getElementById("row-kda"),
  lvl: document.getElementById("row-lvl"),
};

// Which metrics matter per lane, in display order. Laners care about farm/gold;
// junglers and supports live on kill participation + vision, not CS. Unknown
// position (ARAM, unranked blind) falls back to the generic set.
const ROLE_METRICS = {
  TOP: ["csm", "kp", "kda", "lvl"],
  MIDDLE: ["csm", "kp", "kda", "lvl"],
  BOTTOM: ["csm", "gpm", "kda", "lvl"],
  JUNGLE: ["kp", "vision", "kda", "lvl"],
  UTILITY: ["vision", "kp", "kda", "lvl"],
  DEFAULT: ["csm", "kp", "kda", "lvl"],
};

function applyRole(role) {
  const keys = ROLE_METRICS[role] || ROLE_METRICS.DEFAULT;
  for (const key of Object.keys(rows)) {
    const el = rows[key];
    if (!el) continue;
    const idx = keys.indexOf(key);
    if (idx === -1) {
      el.classList.add("hidden");
    } else {
      el.classList.remove("hidden");
      el.style.order = String(idx);
    }
  }
}

let mode = "design"; // "design" | "live"
let gameActive = false;
let watchdog = null;

const fmtInt = (n) => Math.round(n).toLocaleString();
const DASH = "—";

// ---- CSM sparkline -----------------------------------------------------------
// viewBox is 64x22; we render across an inner box so the dot/stroke don't clip.
const SPARK_MAX = 24;
const SPARK_W = 64;
const SPARK_H = 22;
const SPARK_PAD = 3;
const csmHistory = [];

function pushCsm(v) {
  if (typeof v !== "number" || !isFinite(v)) return;
  csmHistory.push(v);
  if (csmHistory.length > SPARK_MAX) csmHistory.shift();
}

function drawSpark() {
  if (csmHistory.length < 2) {
    els.sparkLine.setAttribute("points", "");
    els.sparkDot.setAttribute("cx", "-9");
    return;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of csmHistory) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const innerW = SPARK_W - SPARK_PAD * 2;
  const innerH = SPARK_H - SPARK_PAD * 2;
  const n = csmHistory.length;
  let lastX = 0;
  let lastY = 0;
  const pts = csmHistory.map((v, i) => {
    const x = SPARK_PAD + (i / (n - 1)) * innerW;
    // invert: higher value = higher on screen (smaller y)
    const y = SPARK_PAD + (1 - (v - min) / span) * innerH;
    lastX = x;
    lastY = y;
    return x.toFixed(1) + "," + y.toFixed(1);
  });
  els.sparkLine.setAttribute("points", pts.join(" "));
  els.sparkDot.setAttribute("cx", lastX.toFixed(1));
  els.sparkDot.setAttribute("cy", lastY.toFixed(1));
}

// ---- Objective timeline ------------------------------------------------------
const STATUS_VIEW = {
  up: { cls: "up", meta: "Available" },
  spawning: { cls: "soon", meta: "First spawn" },
  respawning: { cls: "soon", meta: "Respawn" },
  gone: { cls: "gone", meta: "Taken" },
};

const nodeEls = new Map();

function nodeFor(key, label) {
  let ref = nodeEls.get(key);
  if (ref) return ref;

  const node = document.createElement("div");
  node.className = "node";
  const dot = document.createElement("span");
  dot.className = "node-dot";
  const body = document.createElement("div");
  body.className = "node-body";
  const name = document.createElement("span");
  name.className = "node-name";
  name.textContent = label;
  const meta = document.createElement("span");
  meta.className = "node-meta";
  const time = document.createElement("span");
  time.className = "node-time";

  body.append(name, meta);
  node.append(dot, body, time);
  els.timeline.append(node);

  ref = { node, meta, time };
  nodeEls.set(key, ref);
  return ref;
}

function renderTimers(timers) {
  if (!Array.isArray(timers)) return;
  for (const t of timers) {
    const ref = nodeFor(t.key, t.label);
    const view = STATUS_VIEW[t.status] || { cls: "", meta: "" };
    ref.node.className = "node " + view.cls;
    ref.time.textContent = t.display;
    ref.meta.textContent = view.meta;
  }
}

// ---- Stat rendering ----------------------------------------------------------
function signed(n) {
  const s = n >= 0 ? "+" : "−"; // real minus sign
  return s + Math.abs(n).toFixed(1);
}

function applyStats(compare) {
  if (!compare) return;

  // Show only the metrics that matter for the lane you queued into.
  applyRole(compare.role || "");

  // CSM: show the lane differential when an opponent exists, else your own CSM.
  if (compare.hasOpp && typeof compare.csmDiff === "number") {
    els.csm.textContent = signed(compare.csmDiff);
    els.csm.classList.toggle("neg", compare.csmDiff < 0);
  } else {
    els.csm.textContent = (compare.csmYou || 0).toFixed(1);
    els.csm.classList.remove("neg");
  }
  pushCsm(compare.csmYou);
  drawSpark();

  // GPM: your value only (no enemy gold in the sanctioned feed).
  els.gpm.textContent = fmtInt(compare.gpm || 0);

  // VIS / KP% / KDA / LVL: you / opp.
  els.visYou.textContent = String(compare.vision ? compare.vision.you : 0);
  els.visOpp.textContent =
    compare.vision && compare.vision.opp != null ? String(compare.vision.opp) : DASH;

  els.kpYou.textContent = String(compare.kp ? compare.kp.you : 0);
  els.kpOpp.textContent =
    compare.kp && compare.kp.opp != null ? String(compare.kp.opp) : DASH;

  els.kdaYou.textContent = (compare.kda ? compare.kda.you : 0).toFixed(1);
  els.kdaOpp.textContent =
    compare.kda && compare.kda.opp != null ? compare.kda.opp.toFixed(1) : DASH;

  els.lvlYou.textContent = String(compare.lvl ? compare.lvl.you : 0);
  els.lvlOpp.textContent =
    compare.lvl && compare.lvl.opp != null ? String(compare.lvl.opp) : DASH;
}

function render() {
  const show = mode === "design" || (mode === "live" && gameActive);
  els.widget.classList.toggle("hidden", !show);
  els.widget.classList.toggle("design", mode === "design");
  if (mode === "design") {
    els.status.textContent = "Design Mode · drag title · Ctrl+Shift+D to lock";
  } else {
    els.status.textContent = gameActive ? "" : "Waiting for a live game…";
  }
}

function applyOverlay({ compare, timers, mode: m }) {
  if (m) mode = m;
  applyStats(compare);
  renderTimers(timers);

  gameActive = true;
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    gameActive = false;
    render();
  }, 3000);
  render();
}

// ---- Wire to main, or fall back to a static demo for standalone preview ------
if (window.pepstats && typeof window.pepstats.onOverlay === "function") {
  window.pepstats.onOverlay(applyOverlay);
  if (typeof window.pepstats.onModeChange === "function") {
    window.pepstats.onModeChange((m) => {
      mode = m;
      render();
    });
  }
  render();
} else {
  // Standalone browser preview: seed a believable CSM trend + demo comparison.
  for (const v of [6.1, 6.0, 6.3, 6.8, 7.0, 6.7, 7.1, 7.5]) pushCsm(v);
  mode = "design";
  applyOverlay({
    compare: {
      hasOpp: true,
      role: "MIDDLE",
      csmYou: 7.5,
      csmDiff: 1.9,
      gpm: 506,
      kp: { you: 62, opp: 48 },
      kda: { you: 7.2, opp: 2.8 },
      lvl: { you: 9, opp: 8 },
      vision: { you: 12, opp: 9 },
    },
    timers: [
      { key: "grubs", label: "Void Grubs", status: "up", display: "0:00" },
      { key: "herald", label: "Rift Herald", status: "spawning", display: "2:14" },
      { key: "dragon", label: "Dragon", status: "gone", display: "4:30" },
    ],
    mode: "design",
  });
}
