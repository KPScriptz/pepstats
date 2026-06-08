"use strict";

const els = {
  frame: document.getElementById("widget-frame"),
  widget: document.getElementById("widget"),
  dragHandle: document.getElementById("drag-handle"),
  resizeHandle: document.getElementById("resize-handle"),
  rankTag: document.getElementById("rank-tag"),
  csm: document.getElementById("csm"),
  pacePip: document.getElementById("csm-pace"),
  sparkLine: document.getElementById("spark-line"),
  sparkDot: document.getElementById("spark-dot"),
  gpm: document.getElementById("gpm"),
  visYou: document.getElementById("vis-you"),
  visBase: document.getElementById("vis-base"),
  kpYou: document.getElementById("kp-you"),
  kpBase: document.getElementById("kp-base"),
  kdaYou: document.getElementById("kda-you"),
  kdaBase: document.getElementById("kda-base"),
  lvlYou: document.getElementById("lvl-you"),
  status: document.getElementById("status"),
  divider: document.getElementById("divider"),
  timeline: document.getElementById("timeline"),
  skillRow: document.getElementById("skill-row"),
  skillBadges: document.getElementById("skill-badges"),
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

let lastRole = "";
function applyRole(role) {
  lastRole = role;
  const keys = ROLE_METRICS[role] || ROLE_METRICS.DEFAULT;
  const userRows = (window.__pepTheme && window.__pepTheme.overlay && window.__pepTheme.overlay.rows) || {};
  for (const key of Object.keys(rows)) {
    const el = rows[key];
    if (!el) continue;
    const idx = keys.indexOf(key);
    const userOn = userRows[key] !== false; // user can hide a row regardless of role
    if (idx === -1 || !userOn) {
      el.classList.add("hidden");
    } else {
      el.classList.remove("hidden");
      el.style.order = String(idx);
    }
  }
}

// Re-apply row visibility immediately when the user changes overlay settings.
document.addEventListener("pep-theme", () => applyRole(lastRole));

let mode = "design"; // "design" | "live"
let gameActive = false;
let watchdog = null;

const fmtInt = (n) => Math.round(n).toLocaleString();
const DASH = "—";
const PACE_TARGET = 8.5; // "Challenger pace" CS/min reference for the pace pip

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

  // No neutral objectives (ARAM / Arena / etc.) -> hide the whole section so
  // the overlay collapses to just the stat block instead of showing stale or
  // phantom Rift objectives.
  const hasTimers = timers.length > 0;
  if (els.divider) els.divider.classList.toggle("hidden", !hasTimers);
  els.timeline.classList.toggle("hidden", !hasTimers);
  if (!hasTimers) {
    for (const ref of nodeEls.values()) ref.node.remove();
    nodeEls.clear();
    return;
  }

  // Prune nodes no longer in the feed — inhibitor timers come and go as they're
  // destroyed and regenerate, so a stale "respawning" row must be removed.
  const present = new Set(timers.map((t) => t.key));
  for (const key of Array.from(nodeEls.keys())) {
    if (!present.has(key)) {
      nodeEls.get(key).node.remove();
      nodeEls.delete(key);
    }
  }

  for (const t of timers) {
    const ref = nodeFor(t.key, t.label);
    const view = STATUS_VIEW[t.status] || { cls: "", meta: "" };
    ref.node.className = "node " + view.cls;
    ref.time.textContent = t.display;
    ref.meta.textContent = view.meta;
  }
}

// ---- Skill-order hint --------------------------------------------------------
// Renders the Q/W/E max-priority order with the ability to put your next point
// into highlighted. When the next point is the ultimate, an R badge leads.
function renderSkill(skill) {
  if (!els.skillRow || !els.skillBadges) return;
  if (!skill || !Array.isArray(skill.order) || !skill.order.length) {
    els.skillRow.classList.add("hidden");
    return;
  }
  els.skillRow.classList.remove("hidden");
  const seq = skill.next === "R" ? ["R", ...skill.order] : skill.order.slice();
  els.skillBadges.textContent = "";
  for (const k of seq) {
    const b = document.createElement("span");
    b.className =
      "skill-badge" + (k === skill.next ? " next" : "") + (k === "R" ? " ult" : "");
    b.textContent = k;
    els.skillBadges.append(b);
  }
}

// ---- Stat rendering ----------------------------------------------------------
function signed(n) {
  const s = n >= 0 ? "+" : "−"; // real minus sign
  return s + Math.abs(n).toFixed(1);
}

function applyStats(compare) {
  if (!compare) return;

  // Show only the metrics that matter for the lane you queued into (or the
  // generic set off-SR, where role is empty).
  applyRole(compare.role || "");

  // Rank baseline label, e.g. "vs GOLD". Empty when no rank is known.
  els.rankTag.textContent = compare.rank ? "vs " + compare.rank : "";

  // CSM: differential vs your rank's average CS/min when a baseline exists,
  // else your own CSM. Right column elsewhere is "you / rank average".
  if (typeof compare.csmDiff === "number") {
    els.csm.textContent = signed(compare.csmDiff);
    els.csm.classList.toggle("neg", compare.csmDiff < 0);
  } else {
    els.csm.textContent = (compare.csmYou || 0).toFixed(1);
    els.csm.classList.remove("neg");
  }
  pushCsm(compare.csmYou);
  drawSpark();

  // Pro-pace pip (Blitz-style): glow green at/above Challenger CS/min, dim red
  // below. Your own CS only — hidden until there's meaningful farm on the board.
  if (els.pacePip) {
    const csm = compare.csmYou || 0;
    if (csm <= 0) {
      els.pacePip.classList.add("hidden");
    } else {
      els.pacePip.classList.remove("hidden");
      const ahead = csm >= PACE_TARGET;
      els.pacePip.classList.toggle("ahead", ahead);
      els.pacePip.classList.toggle("behind", !ahead);
    }
  }

  // GPM: your value only (no enemy gold in the sanctioned feed).
  els.gpm.textContent = fmtInt(compare.gpm || 0);

  // VIS / KP% / KDA: you / rank-average baseline.
  els.visYou.textContent = String(compare.vision ? compare.vision.you : 0);
  els.visBase.textContent =
    compare.vision && compare.vision.baseline != null ? String(compare.vision.baseline) : DASH;

  els.kpYou.textContent = String(compare.kp ? compare.kp.you : 0);
  els.kpBase.textContent =
    compare.kp && compare.kp.baseline != null ? String(compare.kp.baseline) : DASH;

  els.kdaYou.textContent = (compare.kda ? compare.kda.you : 0).toFixed(1);
  els.kdaBase.textContent =
    compare.kda && compare.kda.baseline != null ? compare.kda.baseline.toFixed(1) : DASH;

  // LVL: your value only (level is time-driven, not a rank-average stat).
  els.lvlYou.textContent = String(compare.lvl ? compare.lvl.you : 0);
}

function render() {
  const show = mode === "design" || (mode === "live" && gameActive);
  els.widget.classList.toggle("hidden", !show);
  // Spec: toggle `.design-mode` on the document body (drives dashed borders +
  // resize grips across the whole overlay), not just the widget.
  document.body.classList.toggle("design-mode", mode === "design");
  if (mode === "design") {
    els.status.textContent = "Design Mode · drag title · Ctrl+Shift+D to lock";
  } else {
    els.status.textContent = gameActive ? "" : "Waiting for a live game…";
  }
}

// ---- Design-Mode drag + resize (persisted to localStorage) -------------------
// Vanilla mouse listeners only (no libraries). All visual updates are coalesced
// into one rAF and applied as a single transform/position write, so dragging
// stays GPU-cheap and never thrashes layout during a match.
const LAYOUT_KEY = "pep-overlay-layout";
const WIDGET_BASE_W = 204; // must match .widget width in styles.css
const MIN_SCALE = 0.6, MAX_SCALE = 1.8;

const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, typeof s === "number" && isFinite(s) ? s : 1));

function loadLayout() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
    if (raw && typeof raw.x === "number" && typeof raw.y === "number") {
      return { x: raw.x, y: raw.y, scale: clampScale(raw.scale) };
    }
  } catch (_) { /* fall through to default */ }
  const themeScale = (window.__pepTheme && window.__pepTheme.overlay && window.__pepTheme.overlay.scale) || 1;
  const scale = clampScale(themeScale);
  const x = Math.max(8, (window.innerWidth || 1280) - WIDGET_BASE_W * scale - 20);
  return { x, y: 16, scale };
}

const layout = loadLayout();
let dragState = null;
let resizeState = null;
let rafPending = false;

function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (_) {}
}

function applyLayout() {
  // Keep the widget on-screen (visual size = unscaled box × scale).
  const w = WIDGET_BASE_W * layout.scale;
  const visH = (els.frame.offsetHeight || 200) * layout.scale;
  layout.x = Math.min(Math.max(0, (window.innerWidth || 1280) - w), Math.max(0, layout.x));
  layout.y = Math.min(Math.max(0, (window.innerHeight || 720) - Math.min(visH, window.innerHeight || 720)), Math.max(0, layout.y));
  els.frame.style.left = layout.x + "px";
  els.frame.style.top = layout.y + "px";
  els.frame.style.transform = "scale(" + layout.scale + ")";
}

function scheduleApply() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; applyLayout(); });
}

function onPointerMove(e) {
  if (dragState) {
    layout.x = dragState.ox + (e.clientX - dragState.startX);
    layout.y = dragState.oy + (e.clientY - dragState.startY);
    scheduleApply();
  } else if (resizeState) {
    layout.scale = clampScale(resizeState.oscale + (e.clientX - resizeState.startX) / WIDGET_BASE_W);
    scheduleApply();
  }
}

function endInteraction() {
  if (dragState || resizeState) {
    dragState = null;
    resizeState = null;
    saveLayout();
  }
  window.removeEventListener("mousemove", onPointerMove);
  window.removeEventListener("mouseup", endInteraction);
}

function beginInteraction() {
  window.addEventListener("mousemove", onPointerMove);
  window.addEventListener("mouseup", endInteraction);
}

els.widget.addEventListener("mousedown", (e) => {
  if (mode !== "design") return; // live mode is click-through anyway
  e.preventDefault();
  dragState = { startX: e.clientX, startY: e.clientY, ox: layout.x, oy: layout.y };
  beginInteraction();
});

els.resizeHandle.addEventListener("mousedown", (e) => {
  if (mode !== "design") return;
  e.preventDefault();
  e.stopPropagation();
  resizeState = { startX: e.clientX, oscale: layout.scale };
  beginInteraction();
});

window.addEventListener("resize", applyLayout);
applyLayout();

function applyOverlay({ scores, compare, timers, skill, mode: m }) {
  if (m) mode = m;
  applyStats(compare);
  renderSkill(skill);
  renderTimers(timers);

  // Champion Sync: tint the dynamic accent to the champion being played.
  if (window.syncAppTheme && scores && scores.champion) {
    const enabled = !(window.__pepTheme && window.__pepTheme.championSync === false);
    window.syncAppTheme(scores.champion, enabled);
  }

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
  // Match just went live — drop any lingering design-mode outline/interaction.
  if (typeof window.pepstats.onForceDesignOff === "function") {
    window.pepstats.onForceDesignOff(() => {
      mode = "live";
      document.body.classList.remove("design-mode");
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
      role: "MIDDLE",
      rank: "GOLD",
      baselineSource: "table",
      csmYou: 7.5,
      csmBaseline: 6.1,
      csmDiff: 1.4,
      gpm: 506,
      kp: { you: 62, baseline: 49 },
      kda: { you: 7.2, baseline: 2.5 },
      lvl: { you: 9 },
      vision: { you: 12, baseline: 9 },
    },
    skill: { order: ["Q", "E", "W"], next: "Q", ranks: { Q: 3, W: 1, E: 2, R: 1 } },
    timers: [
      { key: "grubs", label: "Void Grubs", status: "up", display: "0:00" },
      { key: "herald", label: "Rift Herald", status: "spawning", display: "2:14" },
      { key: "dragon", label: "Dragon", status: "gone", display: "4:30" },
      { key: "inhib-Barracks_T2C1", label: "Inhib Mid (R)", status: "respawning", display: "4:00" },
    ],
    mode: "design",
  });
}
