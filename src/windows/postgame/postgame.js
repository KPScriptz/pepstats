"use strict";

document.getElementById("close").addEventListener("click", () => window.close());

const out = document.getElementById("coach-out");
const coachBtn = document.getElementById("coach");

/* ---- Summary cards ---- */
function fillCards(s) {
  const set = (id, v) => (document.getElementById(id).textContent = v);
  if (!s) {
    set("c-champ", "No game");
    return;
  }
  set("c-champ", s.champion || "—");
  set("c-kda", `${s.kda.k}/${s.kda.d}/${s.kda.a}`);
  set("c-cs", Math.round(s.cs).toString());
  set("c-cspm", s.csPerMin.toFixed(1));
  set("c-gold", Math.round(s.gold).toLocaleString());
  set("c-dur", Math.floor(s.gameTime / 60) + " min");
}

/* ---- Placeholder gold-differential timeline ----
   Illustrative only: the sanctioned Live Client API exposes just the active
   player's gold, so there's no real minute-by-minute lane differential to plot. */
const GOLD_DIFF = [
  0, 120, 300, 250, 520, 480, 760, 900, 680, 1100, 1320, 980, 760, 400,
  -150, -520, -300, 200, 760, 1280, 1750, 1500, 1900, 2200, 2050, 2400,
];
const VB_W = 600, VB_H = 170, ZERO_Y = 85, MAX_ABS = 3000;
const N = GOLD_DIFF.length;

const xAt = (i) => (i / (N - 1)) * VB_W;
const yAt = (v) => ZERO_Y - (Math.max(-MAX_ABS, Math.min(MAX_ABS, v)) / MAX_ABS) * ZERO_Y;

function drawGraph() {
  const line = GOLD_DIFF.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
  document.getElementById("graph-line").setAttribute("points", line);

  // Filled envelopes: green above the zero line, red below it.
  const posPts = [`0,${ZERO_Y}`, ...GOLD_DIFF.map((v, i) => `${xAt(i).toFixed(1)},${Math.min(yAt(v), ZERO_Y).toFixed(1)}`), `${VB_W},${ZERO_Y}`];
  const negPts = [`0,${ZERO_Y}`, ...GOLD_DIFF.map((v, i) => `${xAt(i).toFixed(1)},${Math.max(yAt(v), ZERO_Y).toFixed(1)}`), `${VB_W},${ZERO_Y}`];
  document.getElementById("graph-area-pos").setAttribute("points", posPts.join(" "));
  document.getElementById("graph-area-neg").setAttribute("points", negPts.join(" "));
}

function wireGraphHover() {
  const svg = document.getElementById("gold-graph");
  const cursor = document.getElementById("graph-cursor");
  const marker = document.getElementById("graph-marker");
  const readout = document.getElementById("graph-readout");

  svg.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const i = Math.round(frac * (N - 1));
    const x = xAt(i), y = yAt(GOLD_DIFF[i]);

    cursor.setAttribute("x1", x); cursor.setAttribute("x2", x);
    marker.setAttribute("cx", x); marker.setAttribute("cy", y);

    const sign = GOLD_DIFF[i] > 0 ? "+" : GOLD_DIFF[i] < 0 ? "−" : "±";
    readout.textContent = `${i}:00   ${sign}${Math.abs(GOLD_DIFF[i]).toLocaleString()}g`;
    svg.classList.add("active");
  });
  svg.addEventListener("mouseleave", () => {
    svg.classList.remove("active");
    readout.textContent = "Hover the timeline";
  });
}

/* ---- Claude tactical review ---- */
coachBtn.addEventListener("click", async () => {
  coachBtn.disabled = true;
  out.textContent = "Analyzing your match…";
  try {
    const res = await window.pepstats.requestCoach();
    out.textContent = res.text;
  } catch (e) {
    out.textContent = "Coach request failed: " + e.message;
  }
  coachBtn.disabled = false;
});

/* ---- Init ---- */
drawGraph();
wireGraphHover();
(async () => {
  fillCards(await window.pepstats.getLastGame());
})();
