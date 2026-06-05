"use strict";

const els = {
  widget: document.getElementById("widget"),
  cs: document.getElementById("cs"),
  cspm: document.getElementById("cspm"),
  gold: document.getElementById("gold"),
  status: document.getElementById("status"),
  timeline: document.getElementById("timeline"),
};

let mode = "design"; // "design" | "live"
let gameActive = false;
let watchdog = null;

const fmtInt = (n) => Math.round(n).toLocaleString();

// timers.js status -> overlay css class + caption
const STATUS_VIEW = {
  up: { cls: "up", meta: "Available" },
  spawning: { cls: "soon", meta: "First spawn" },
  respawning: { cls: "soon", meta: "Respawn" },
  gone: { cls: "gone", meta: "Taken" },
};

// Cache node elements by objective key so updates don't rebuild the DOM.
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

window.pepstats.onOverlay(({ scores, timers, mode: m }) => {
  if (m) mode = m;
  els.cs.textContent = fmtInt(scores.cs);
  els.cspm.textContent = scores.csPerMin.toFixed(1);
  els.gold.textContent = fmtInt(scores.gold);

  renderTimers(timers);

  gameActive = true;
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    gameActive = false;
    render();
  }, 3000);
  render();
});

window.pepstats.onModeChange((m) => {
  mode = m;
  render();
});

render();
