"use strict";

const els = {
  widget: document.getElementById("widget"),
  cs: document.getElementById("cs"),
  cspm: document.getElementById("cspm"),
  gold: document.getElementById("gold"),
  status: document.getElementById("status"),
  nodes: {
    grubs: { node: document.getElementById("n-grubs"), time: document.getElementById("t-grubs"), meta: document.getElementById("m-grubs") },
    dragon: { node: document.getElementById("n-dragon"), time: document.getElementById("t-dragon"), meta: document.getElementById("m-dragon") },
    baron: { node: document.getElementById("n-baron"), time: document.getElementById("t-baron"), meta: document.getElementById("m-baron") },
  },
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

function paintNode(key, t) {
  const ref = els.nodes[key];
  if (!ref || !t) return;
  const view = STATUS_VIEW[t.status] || { cls: "", meta: "" };
  ref.node.className = "node " + view.cls;
  ref.time.textContent = t.display;
  ref.meta.textContent = view.meta;
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

  paintNode("grubs", timers.grubs);
  paintNode("dragon", timers.dragon);
  paintNode("baron", timers.baron);

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
