"use strict";

const els = {
  widget: document.getElementById("widget"),
  cs: document.getElementById("cs"),
  cspm: document.getElementById("cspm"),
  gold: document.getElementById("gold"),
  dragon: document.getElementById("t-dragon"),
  baron: document.getElementById("t-baron"),
  grubs: document.getElementById("t-grubs"),
  status: document.getElementById("status"),
};

let mode = "design"; // "design" | "live"
let gameActive = false;
let watchdog = null;

const fmtInt = (n) => Math.round(n).toLocaleString();

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
  els.dragon.textContent = timers.dragon.display;
  els.baron.textContent = timers.baron.display;
  els.grubs.textContent = timers.grubs.display;

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
