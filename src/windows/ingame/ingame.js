"use strict";

const els = {
  status: document.getElementById("status"),
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
  timeline: document.getElementById("timeline"),
  skillRow: document.getElementById("skill-row"),
  skillBadges: document.getElementById("skill-badges"),
  dossier: document.getElementById("dossier"),
  dossierOpp: document.getElementById("dossier-opp"),
  dosCsmYou: document.getElementById("dos-csm-you"),
  dosCsmOpp: document.getElementById("dos-csm-opp"),
  dosKdaYou: document.getElementById("dos-kda-you"),
  dosKdaOpp: document.getElementById("dos-kda-opp"),
  dosLvlYou: document.getElementById("dos-lvl-you"),
  dosLvlOpp: document.getElementById("dos-lvl-opp"),
  toastStack: document.getElementById("toast-stack"),
};

// Draggable overlay modules — each persists its own position + scale.
// timers are individual chips; golddiff/jungle are the opt-in extras. (The
// Enemy-Ult/Flash trackers were removed in 0.5.11 — Riot policy forbids enemy
// cooldown timers, even manual ones. See COMPLIANCE.md.)
const MODULES = ["stats", "skill", "toasts", "golddiff", "jungle"];
const mods = {};
for (const _id of MODULES) mods[_id] = document.getElementById("mod-" + _id);

// Content-presence flags drive per-module visibility in Live Mode.
let hasSkill = false, hasTimers = false, hasGoldDiff = false;

// ---- Per-module visibility toggles (Design Mode), persisted to config -------
// Each module gets an eye button in Design Mode. Toggling off hides the whole
// module from live gameplay AND saves the state to config (config.ui.overlay.
// modules), so it stays disabled in future matches — same store as the row
// toggles. A disabled module stays visible (dimmed) in Design Mode so it can be
// re-enabled.
const EYE_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path class="eye-ball" d="M12 5.5C6.7 5.5 2.8 9 1.2 12c1.6 3 5.5 6.5 10.8 6.5S21.2 15 22.8 12C21.2 9 17.3 5.5 12 5.5z"/>' +
  '<circle class="eye-pupil" cx="12" cy="12" r="2.4"/>' +
  '<line class="eye-strike" x1="3" y1="21" x2="21" y2="3"/></svg>';

function loadModuleEnabled() {
  const m = (window.__pepTheme && window.__pepTheme.overlay && window.__pepTheme.overlay.modules) || {};
  const out = {};
  for (const id of MODULES) out[id] = m[id] !== false; // default on
  return out;
}
let modEnabled = loadModuleEnabled();

for (const id of MODULES) {
  const el = mods[id];
  if (!el) continue;
  const btn = document.createElement("button");
  btn.className = "mod-toggle";
  btn.title = "Hide / show this panel";
  btn.innerHTML = EYE_SVG;
  btn.addEventListener("mousedown", (e) => e.stopPropagation()); // don't start a drag
  btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleModule(id); });
  el.appendChild(btn);
  el.classList.toggle("mod-off", !modEnabled[id]);
}

function toggleModule(id) {
  modEnabled[id] = !modEnabled[id];
  mods[id].classList.toggle("mod-off", !modEnabled[id]);
  render();
  if (window.pepstats && typeof window.pepstats.saveTheme === "function") {
    window.pepstats.saveTheme({ overlay: { modules: { ...modEnabled } } });
  }
}

// Re-sync if the config/theme changes elsewhere (e.g. a future Settings panel).
document.addEventListener("pep-theme", () => {
  modEnabled = loadModuleEnabled();
  for (const mid of MODULES) if (mods[mid]) mods[mid].classList.toggle("mod-off", !modEnabled[mid]);
  render();
});

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

// ---- Individual draggable objective-timer chips ------------------------------
// Each objective is a free-floating chip the user drags wherever they like (e.g.
// by eye over their own minimap). Live Mode = bare countdown number only; Design
// Mode = labeled, dashed, draggable, with a hide toggle. The app reads NOTHING
// from the game — it just positions our own elements with PUBLIC timer data
// (no minimap detection, no auto-snap). Per-chip position + hidden state persist
// to localStorage so the layout survives future matches.
const TIMERS_KEY = "pep-overlay-timers"; // { [objKey]: { x, y, hidden } }
let timerLayouts = {};
try { timerLayouts = JSON.parse(localStorage.getItem(TIMERS_KEY) || "{}") || {}; } catch (_) { timerLayouts = {}; }
function saveTimerLayouts() { try { localStorage.setItem(TIMERS_KEY, JSON.stringify(timerLayouts)); } catch (_) {} }

const STATUS_CLS = { up: "up", spawning: "soon", respawning: "soon", gone: "gone" };
const chips = {}; // objKey -> element
let chipSpawnN = 0;

function getChip(key) {
  let el = chips[key];
  if (el) return el;
  el = document.createElement("div");
  el.className = "timer-chip";
  el.dataset.timer = key;
  const label = document.createElement("span"); label.className = "tc-label";
  const num = document.createElement("span"); num.className = "tc-num";
  const tog = document.createElement("button"); tog.className = "tc-toggle"; tog.title = "Hide this timer"; tog.innerHTML = EYE_SVG;
  tog.addEventListener("mousedown", (e) => e.stopPropagation());
  tog.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleTimer(key); });
  el.append(label, num, tog);
  document.body.appendChild(el);
  chips[key] = el;
  if (!timerLayouts[key]) {
    // Default to a left-edge column so new chips don't pile onto the right-side
    // modules; the user drags each onto their minimap spot from there.
    timerLayouts[key] = { x: 22, y: 80 + (chipSpawnN++ % 14) * 30, hidden: false };
  }
  return el;
}

function applyChip(key) {
  const el = chips[key], L = timerLayouts[key];
  if (!el || !L) return;
  const winW = window.innerWidth || 1280, winH = window.innerHeight || 720;
  L.x = Math.min(Math.max(0, winW - (el.offsetWidth || 40)), Math.max(0, L.x));
  L.y = Math.min(Math.max(0, winH - (el.offsetHeight || 18)), Math.max(0, L.y));
  el.style.left = L.x + "px";
  el.style.top = L.y + "px";
  el.classList.toggle("tc-off", !!L.hidden);
}

function toggleTimer(key) {
  if (!timerLayouts[key]) return;
  timerLayouts[key].hidden = !timerLayouts[key].hidden;
  applyChip(key);
  updateChipVisibility();
  saveTimerLayouts();
}

// Design Mode shows every chip (dimmed if hidden) so any can be placed/re-enabled;
// Live Mode shows only the non-hidden ones, and only while a game is active.
function updateChipVisibility() {
  const design = mode === "design";
  const liveOn = mode === "live" && gameActive;
  for (const key of Object.keys(chips)) {
    const hidden = !!(timerLayouts[key] && timerLayouts[key].hidden);
    chips[key].classList.toggle("hidden", !(design || (liveOn && !hidden)));
  }
}

function renderTimers(timers) {
  if (!Array.isArray(timers)) timers = [];
  hasTimers = timers.length > 0;
  const present = new Set();
  for (const t of timers) {
    if (t.status === "gone") continue; // a taken objective has nothing to place
    present.add(t.key);
    const el = getChip(t.key);
    el.querySelector(".tc-label").textContent = t.label;
    el.querySelector(".tc-num").textContent = t.display;
    el.className = "timer-chip " + (STATUS_CLS[t.status] || ""); // CSS targets .timer-chip.up/.soon (no tc- prefix)
    if (timerLayouts[t.key] && timerLayouts[t.key].hidden) el.classList.add("tc-off");
    applyChip(t.key);
  }
  // Drop chips for objectives no longer in the feed (keep their saved layout).
  for (const key of Object.keys(chips)) {
    if (!present.has(key)) { chips[key].remove(); delete chips[key]; }
  }
  updateChipVisibility();
}

// ---- Skill-order hint --------------------------------------------------------
// Renders the Q/W/E max-priority order with the ability to put your next point
// into highlighted. When the next point is the ultimate, an R badge leads.
function renderSkill(skill) {
  if (!els.skillBadges) return;
  hasSkill = !!(skill && Array.isArray(skill.order) && skill.order.length);
  if (!hasSkill) { els.skillBadges.textContent = ""; return; } // Skill module hides via render()
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

function setMod(id, show) {
  if (mods[id]) mods[id].classList.toggle("hidden", !show);
}
function render() {
  const design = mode === "design";
  const liveOn = mode === "live" && gameActive;
  document.body.classList.toggle("design-mode", design);
  // Design Mode shows every module (dimmed if disabled) so each can be placed or
  // re-enabled; Live Mode shows only enabled modules that have content. Modules
  // not listed here are content-less (always "ok").
  const contentOk = { skill: hasSkill, golddiff: hasGoldDiff };
  for (const id of MODULES) {
    const ok = id in contentOk ? contentOk[id] : true;
    setMod(id, design || (liveOn && ok && modEnabled[id]));
  }
  if (typeof updateChipVisibility === "function") updateChipVisibility(); // timer chips
  const showStatus = design || (mode === "live" && !gameActive);
  els.status.classList.toggle("hidden", !showStatus);
  els.status.textContent = design
    ? "Design Mode · drag each panel · resize from the corner · Ctrl+Shift+D to lock"
    : (gameActive ? "" : "Waiting for a live game…");
}

// ---- Design-Mode drag + resize, PER MODULE (persisted to localStorage) -------
// Each module carries its own { x, y, scale }. Vanilla mouse listeners only; all
// visual updates coalesce into one rAF so dragging stays GPU-cheap. The app
// never reads the game's UI — the user positions every panel by eye.
const MODULES_KEY = "pep-overlay-modules";
const MIN_SCALE = 0.6, MAX_SCALE = 1.8;
const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, typeof s === "number" && isFinite(s) ? s : 1));

function defaultLayouts() {
  // Right column for the core modules; left column for the opt-in P3.4 extras.
  const right = Math.max(8, (window.innerWidth || 1280) - 224);
  const left = 24;
  return {
    stats: { x: right, y: 16, scale: 1 },
    skill: { x: right, y: 250, scale: 1 },
    toasts: { x: right, y: 320, scale: 1 },
    golddiff: { x: right, y: 470, scale: 1 },
    jungle: { x: left, y: 360, scale: 1 },
  };
}
function loadLayouts() {
  const out = defaultLayouts();
  try {
    const raw = JSON.parse(localStorage.getItem(MODULES_KEY) || "null");
    if (raw && typeof raw === "object") {
      for (const id of MODULES) {
        const r = raw[id];
        if (r && typeof r.x === "number" && typeof r.y === "number") {
          out[id] = { x: r.x, y: r.y, scale: clampScale(r.scale) };
        }
      }
    }
  } catch (_) { /* defaults */ }
  return out;
}
const layouts = loadLayouts();
function saveLayouts() { try { localStorage.setItem(MODULES_KEY, JSON.stringify(layouts)); } catch (_) {} }

function applyModule(id) {
  const el = mods[id], L = layouts[id];
  if (!el || !L) return;
  const w = (el.offsetWidth || 204) * L.scale;
  const h = (el.offsetHeight || 60) * L.scale;
  const winW = window.innerWidth || 1280, winH = window.innerHeight || 720;
  L.x = Math.min(Math.max(0, winW - w), Math.max(0, L.x));
  L.y = Math.min(Math.max(0, winH - Math.min(h, winH)), Math.max(0, L.y));
  el.style.left = L.x + "px";
  el.style.top = L.y + "px";
  el.style.transform = "scale(" + L.scale + ")";
}
function applyAllModules() { for (const id of MODULES) applyModule(id); }

// Generic over any draggable item (module OR timer chip): drag/resize each hold
// the item's layout object + its apply()/save() callbacks.
let drag = null;   // { L, apply, save, startX, startY, ox, oy }
let resize = null; // { L, apply, save, startX, oscale, baseW }
let rafPending = false;
function scheduleApply() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; const a = drag || resize; if (a) a.apply(); });
}
function onMove(e) {
  if (drag) {
    drag.L.x = drag.ox + (e.clientX - drag.startX);
    drag.L.y = drag.oy + (e.clientY - drag.startY);
    scheduleApply();
  } else if (resize) {
    resize.L.scale = clampScale(resize.oscale + (e.clientX - resize.startX) / resize.baseW);
    scheduleApply();
  }
}
function onUp() {
  const a = drag || resize;
  if (a) { a.apply(); drag = null; resize = null; a.save(); } // apply final drop, then persist
  window.removeEventListener("mousemove", onMove);
  window.removeEventListener("mouseup", onUp);
}
function begin() {
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

document.addEventListener("mousedown", (e) => {
  if (mode !== "design") return; // live mode is click-through anyway
  // Individual timer chip (drag only)?
  const chipEl = e.target.closest(".timer-chip");
  if (chipEl) {
    const key = chipEl.dataset.timer, L = timerLayouts[key];
    if (!L) return;
    e.preventDefault();
    drag = { L, apply: () => applyChip(key), save: saveTimerLayouts, startX: e.clientX, startY: e.clientY, ox: L.x, oy: L.y };
    begin();
    return;
  }
  // Module (drag or corner-resize)?
  const modEl = e.target.closest(".mod");
  if (!modEl) return;
  const id = modEl.dataset.mod, L = layouts[id];
  if (e.target.closest(".mod-resize")) {
    e.preventDefault(); e.stopPropagation();
    resize = { L, apply: () => applyModule(id), save: saveLayouts, startX: e.clientX, oscale: L.scale, baseW: modEl.offsetWidth || 204 };
  } else {
    e.preventDefault();
    drag = { L, apply: () => applyModule(id), save: saveLayouts, startX: e.clientX, startY: e.clientY, ox: L.x, oy: L.y };
  }
  begin();
});

window.addEventListener("resize", () => { applyAllModules(); for (const k of Object.keys(chips)) applyChip(k); });
applyAllModules();

// ---- #2 Lane dossier: you vs your direct lane opponent ----
function renderDossier(dossier) {
  if (!els.dossier) return;
  if (!dossier || !dossier.hasOpp || !dossier.opp) {
    els.dossier.classList.add("hidden");
    return;
  }
  els.dossier.classList.remove("hidden");
  els.dossierOpp.textContent = "vs " + (dossier.opp.champion || "—");
  const set = (yEl, oEl, yv, ov) => {
    yEl.textContent = yv;
    oEl.textContent = ov;
    const ahead = parseFloat(yv) >= parseFloat(ov); // higher is better for CSM/KDA/LVL
    yEl.classList.toggle("ahead", ahead);
    yEl.classList.toggle("behind", !ahead);
  };
  set(els.dosCsmYou, els.dosCsmOpp, dossier.you.csm.toFixed(1), dossier.opp.csm.toFixed(1));
  set(els.dosKdaYou, els.dosKdaOpp, dossier.you.kda.toFixed(1), dossier.opp.kda.toFixed(1));
  set(els.dosLvlYou, els.dosLvlOpp, String(dossier.you.lvl), String(dossier.opp.lvl));
}

// ---- #11 Highlight toast: your own combat milestones ----
const TOAST_MS = 4200;
function showToast(h) {
  if (!modEnabled.toasts) return; // Toasts module toggled off — suppress entirely
  if (!els.toastStack || !h || !h.label) return;
  const t = document.createElement("div");
  t.className = "toast toast-" + (h.kind || "good");
  const pip = document.createElement("span"); pip.className = "toast-pip";
  const body = document.createElement("div"); body.className = "toast-body";
  const label = document.createElement("div"); label.className = "toast-label"; label.textContent = h.label;
  body.append(label);
  if (h.sub) { const sub = document.createElement("div"); sub.className = "toast-sub"; sub.textContent = h.sub; body.append(sub); }
  t.append(pip, body);
  els.toastStack.append(t);
  setTimeout(() => { t.classList.add("leaving"); setTimeout(() => t.remove(), 340); }, TOAST_MS);
  while (els.toastStack.children.length > 3) els.toastStack.firstChild.remove();
}

// ---- P3.4 Gold-value inventory diff ----
function renderGoldDiff(goldDiff) {
  hasGoldDiff = !!(goldDiff && typeof goldDiff.diff === "number");
  const el = document.getElementById("gd-value");
  if (!el) return;
  if (!hasGoldDiff) { el.textContent = "—"; el.className = "gd-value"; return; }
  const d = goldDiff.diff;
  const k = (g) => (Math.abs(g) >= 1000 ? (g / 1000).toFixed(1) + "k" : String(Math.round(g)));
  el.textContent = (d >= 0 ? "+" : "−") + k(Math.abs(d)) + "g";
  el.className = "gd-value " + (d >= 0 ? "pos" : "neg");
}


function applyOverlay({ scores, compare, timers, skill, dossier, goldDiff, mode: m }) {
  if (m) mode = m;
  applyStats(compare);
  renderSkill(skill);
  renderDossier(dossier);
  renderGoldDiff(goldDiff);
  renderTimers(timers);

  // Champion Sync: tint the dynamic accent to the champion being played.
  if (window.syncAppTheme && scores && scores.champion) {
    const enabled = !(window.__pepTheme && window.__pepTheme.championSync === false);
    window.syncAppTheme(scores.champion, enabled);
  }

  gameActive = true;
  clearTimeout(watchdog);
  // 7s, not 3s: the push cadence is ~1s, but one slow Live-Client read past 3s
  // would blank every module mid-fight and flash them back a tick later.
  watchdog = setTimeout(() => {
    gameActive = false;
    render();
  }, 7000);
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
  if (typeof window.pepstats.onHighlight === "function") {
    window.pepstats.onHighlight(showToast);
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
    dossier: { hasOpp: true, role: "MIDDLE", you: { champion: "Ahri", csm: 7.5, kda: 7.2, lvl: 9 }, opp: { champion: "Zed", csm: 6.8, kda: 2.5, lvl: 8 } },
    goldDiff: { mine: 48200, enemy: 44900, diff: 3300 },
    timers: [
      { key: "camps", label: "Jungle camps", status: "spawning", display: "0:22" },
      { key: "grubs", label: "Void Grubs", status: "up", display: "0:00" },
      { key: "herald", label: "Rift Herald", status: "spawning", display: "2:14" },
      { key: "dragon", label: "Dragon", status: "gone", display: "4:30" },
      { key: "inhib-Barracks_T2C1", label: "Inhib Mid (R)", status: "respawning", display: "4:00" },
    ],
    mode: "design",
  });
  // Demo a highlight toast in standalone preview.
  showToast({ kind: "good", label: "Double Kill", sub: "Ahri" });
}
