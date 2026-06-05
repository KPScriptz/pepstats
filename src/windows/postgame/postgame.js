"use strict";

document.getElementById("close").addEventListener("click", () => window.close());

const out = document.getElementById("coach-out");
const coachBtn = document.getElementById("coach");
const coachWarn = document.getElementById("coach-warning");
const replayLine = document.getElementById("replay-line");

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

function showReplay(replay) {
  if (replay && replay.name) {
    const mb = (replay.sizeBytes / (1024 * 1024)).toFixed(1);
    replayLine.textContent = `Replay: ${replay.name} · ${mb} MB · ${new Date(replay.modified).toLocaleString()}`;
  } else {
    replayLine.textContent = "No replay file detected for this match.";
  }
}

// Proactively reflect whether the AI coach is configured. Main reports this in
// every last-game payload; if config.json / the API key is missing we show a
// banner and lock the button instead of letting the user click into an error.
function renderCoachStatus(coach) {
  if (coach && coach.ready === false) {
    coachWarn.textContent =
      coach.message || "Claude coach unavailable — add your Anthropic API key to config.json.";
    coachWarn.hidden = false;
    coachBtn.disabled = true;
  } else if (coach && coach.ready === true) {
    coachWarn.hidden = true;
    if (!out.classList.contains("streaming")) coachBtn.disabled = false;
  }
}

function applyLastGame(data) {
  if (!data) {
    fillCards(null);
    return;
  }
  fillCards(data.scores);
  showReplay(data.replay);
  renderCoachStatus(data.coach);
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

/* ---- Streaming Claude tactical review (typewriter) ---- */
coachBtn.addEventListener("click", () => {
  coachBtn.disabled = true;
  out.textContent = "";
  out.classList.add("streaming");
  window.pepstats.startCoach();
});

window.pepstats.onCoachChunk((text) => {
  // A stream can arrive without a button click (e.g. the dev mock pipes tokens
  // straight over IPC). Enter streaming mode on the first chunk so the caret
  // shows and the button locks regardless of who started the stream.
  if (!out.classList.contains("streaming")) {
    coachBtn.disabled = true;
    out.classList.add("streaming");
  }
  out.textContent += text;
  out.scrollTop = out.scrollHeight;
});
window.pepstats.onCoachDone(() => {
  coachBtn.disabled = false;
  out.classList.remove("streaming");
});
window.pepstats.onCoachError((msg) => {
  out.textContent = msg;
  coachBtn.disabled = false;
  out.classList.remove("streaming");
});

/* ---- Init ---- */
drawGraph();
wireGraphHover();
window.pepstats.onLastGame(applyLastGame); // pushed when a match ends
(async () => {
  applyLastGame(await window.pepstats.getLastGame());
})();
