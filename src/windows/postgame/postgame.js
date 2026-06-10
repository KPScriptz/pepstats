"use strict";

const $ = (id) => document.getElementById(id);
$("close").addEventListener("click", () => window.close());

const out = $("coach-out");
const coachBtn = $("coach");
const coachWarn = $("coach-warning");

let ddVersion = null;
const champImg = (key) => ddVersion ? `https://ddragon.leagueoflegends.com/cdn/${ddVersion}/img/champion/${key}.png` : "";
const fmtT = (sec) => Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");

/* ---- Hero strip + outcome ---- */
function fillHero(s) {
  const set = (id, v) => ($(id).textContent = v);
  if (!s) { set("c-champ", "No game"); return; }
  set("c-champ", s.champion || "—");
  set("c-kda", `${s.k}/${s.d}/${s.a}`);
  set("c-cs", Math.round(s.cs).toString());
  set("c-cspm", (s.csPerMin != null ? s.csPerMin : 0).toFixed(1));
  set("c-gold", Math.round(s.gold).toLocaleString());
  set("c-dur", Math.floor(s.durationSec / 60) + " min");
  const ico = $("c-champ-ico");
  if (s.champKey && ddVersion) { ico.src = champImg(s.champKey); ico.style.display = "block"; } else ico.style.display = "none";
  const badge = $("outcome");
  badge.classList.remove("hidden", "win", "loss");
  badge.classList.add(s.win ? "win" : "loss");
  badge.textContent = s.win ? "VICTORY" : "DEFEAT";
}

/* ---- Performance vs average ---- */
function fillCompare(cmp) {
  const empty = $("cmp-empty"), body = $("cmp-body");
  if (!cmp) { empty.classList.remove("hidden"); body.classList.add("hidden"); return; }
  empty.classList.add("hidden"); body.classList.remove("hidden");
  const cell = (id, now, avg, betterHigh) => {
    $(id + "-now").textContent = now;
    const av = $(id + "-avg");
    av.textContent = "avg " + avg;
    av.className = "cmp-avg " + (now >= avg ? (betterHigh ? "pos" : "neg") : (betterHigh ? "neg" : "pos"));
  };
  cell("cmp-kda", cmp.kda.now, cmp.kda.avg, true);
  cell("cmp-cs", cmp.csPerMin.now, cmp.csPerMin.avg, true);
  $("cmp-note").textContent = `Compared to your last ${cmp.games} game${cmp.games > 1 ? "s" : ""} on this champion.`;
}

/* ---- Objective list ---- */
function fillObjectives(objs) {
  const empty = $("obj-empty"), list = $("obj-list");
  if (!objs || !objs.length) { empty.classList.remove("hidden"); list.classList.add("hidden"); return; }
  empty.classList.add("hidden"); list.classList.remove("hidden"); list.innerHTML = "";
  for (const o of objs) {
    const li = document.createElement("li"); li.className = "obj-row" + (o.byMyTeam ? " mine" : " enemy") + (o.warn ? " warn" : "");
    li.innerHTML = `<span class="obj-t">${fmtT(o.t)}</span><span class="obj-x">${o.label}</span><span class="obj-w">${o.byMyTeam ? "Your team" : "Enemy"}${o.warn ? " · ⚠ " + o.goldAt + "g unspent" : ""}</span>`;
    list.append(li);
  }
}

/* ---- Gold Spending Efficiency chart ---- */
const VB = { w: 600, h: 200, pad: 10 };
let gseState = null;
function drawGSE(gse, objectives) {
  const empty = document.querySelector(".graph-note");
  if (!gse || gse.length < 2) { $("gse-line").setAttribute("points", ""); $("gse-area").setAttribute("points", ""); $("gse-obj").innerHTML = ""; return; }
  const maxT = gse[gse.length - 1].t || 1;
  const maxG = Math.max(1500 * 1.25, ...gse.map((p) => p.gold));
  const X = (t) => VB.pad + (t / maxT) * (VB.w - 2 * VB.pad);
  const Y = (g) => VB.h - VB.pad - (g / maxG) * (VB.h - 2 * VB.pad);
  gseState = { gse, maxT, X, Y };

  $("gse-line").setAttribute("points", gse.map((p) => `${X(p.t).toFixed(1)},${Y(p.gold).toFixed(1)}`).join(" "));
  $("gse-area").setAttribute("points", `${X(0)},${VB.h - VB.pad} ` + gse.map((p) => `${X(p.t).toFixed(1)},${Y(p.gold).toFixed(1)}`).join(" ") + ` ${X(maxT)},${VB.h - VB.pad}`);
  const capY = Y(1500).toFixed(1); $("gse-cap").setAttribute("y1", capY); $("gse-cap").setAttribute("y2", capY);

  const g = $("gse-obj"); g.innerHTML = "";
  for (const o of (objectives || [])) {
    const x = X(o.t).toFixed(1);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x); line.setAttribute("x2", x); line.setAttribute("y1", VB.pad); line.setAttribute("y2", VB.h - VB.pad);
    line.setAttribute("class", "gse-obj-line" + (o.warn ? " warn" : o.byMyTeam ? " mine" : ""));
    g.append(line);
  }
}

function wireGSEHover() {
  const svg = $("gse-graph"), cursor = $("gse-cursor"), marker = $("gse-marker"), readout = $("gse-readout");
  svg.addEventListener("mousemove", (e) => {
    if (!gseState) return;
    const rect = svg.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const t = frac * gseState.maxT;
    let pt = gseState.gse[0];
    for (const p of gseState.gse) { if (Math.abs(p.t - t) < Math.abs(pt.t - t)) pt = p; }
    const x = gseState.X(pt.t), y = gseState.Y(pt.gold);
    cursor.setAttribute("x1", x); cursor.setAttribute("x2", x);
    marker.setAttribute("cx", x); marker.setAttribute("cy", y);
    readout.textContent = `${fmtT(pt.t)} · ${pt.gold.toLocaleString()}g unspent`;
    svg.classList.add("active");
  });
  svg.addEventListener("mouseleave", () => { svg.classList.remove("active"); readout.textContent = "Hover the timeline"; });
}

/* ---- Skill order deviation ---- */
function fillSkill(skill) {
  const empty = $("skill-empty"), body = $("skill-body");
  if (!skill || !skill.path || !skill.path.length) { empty.classList.remove("hidden"); body.classList.add("hidden"); return; }
  empty.classList.add("hidden"); body.classList.remove("hidden");
  const path = $("skill-path"); path.innerHTML = "";
  skill.path.forEach((sk, i) => {
    const c = document.createElement("span"); c.className = "sk-cell s-" + sk; c.textContent = sk; c.title = "Level " + (i + 1); path.append(c);
  });
  $("skill-note").textContent = skill.note || "";
}

/* ---- #9 Team gold differential ---- */
const fmtK = (g) => (Math.abs(g) >= 1000 ? (g / 1000).toFixed(1) + "k" : String(Math.round(g)));
function drawTeamGold(tg) {
  const empty = $("tg-empty"), body = $("tg-body");
  if (!tg || !tg.series || tg.series.length < 2) { empty.classList.remove("hidden"); body.classList.add("hidden"); return; }
  empty.classList.add("hidden"); body.classList.remove("hidden");

  const f = tg.final;
  const total = (f.mine + f.enemy) || 1;
  const minePct = Math.max(8, Math.min(92, Math.round((f.mine / total) * 100)));
  $("tg-mine").style.flex = "0 0 " + minePct + "%";
  $("tg-mine").textContent = minePct + "%";
  $("tg-enemy").textContent = (100 - minePct) + "%";

  const lead = $("tg-lead");
  lead.textContent = (f.diff >= 0 ? "Your team +" : "Enemy +") + fmtK(Math.abs(f.diff)) + "g";
  lead.className = f.diff >= 0 ? "pos" : "neg";
  $("tg-totals").textContent = fmtK(f.mine) + " vs " + fmtK(f.enemy);

  // Diff-over-time line: viewBox 600×120, centre line y=60. Above = you ahead.
  const W = 600, cy = 60, pad = 6;
  const maxT = tg.series[tg.series.length - 1].t || 1;
  const maxAbs = Math.max(1000, ...tg.series.map((p) => Math.abs(p.diff)));
  const X = (t) => (t / maxT) * W;
  const Y = (d) => cy - (Math.max(-maxAbs, Math.min(maxAbs, d)) / maxAbs) * (cy - pad);
  const pts = tg.series.map((p) => `${X(p.t).toFixed(1)},${Y(p.diff).toFixed(1)}`).join(" ");
  $("tg-line").setAttribute("points", pts);
  $("tg-area").setAttribute("points", `${X(0)},${cy} ` + pts + ` ${X(maxT)},${cy}`);
}

/* ---- Apply full analytics payload ---- */
function applyPostgame(data) {
  if (!data) return;
  if (data.version) ddVersion = data.version;
  if (data.ok && data.summary) {
    fillHero(data.summary);
    if (window.syncAppTheme) window.syncAppTheme(data.summary.champion, true);
    fillCompare(data.compare);
    fillObjectives(data.objectives);
    drawGSE(data.gse, data.objectives);
    drawTeamGold(data.teamGold);
    fillSkill(data.skill);
    $("replay-line").textContent = data.replay && data.replay.name
      ? `Replay: ${data.replay.name} · ${(data.replay.sizeBytes / 1048576).toFixed(1)} MB`
      : "Match " + (data.matchId || "");
  } else {
    $("replay-line").textContent = (data.error ? data.error + " " : "") + "Showing limited data.";
  }
  renderCoachStatus(data.coach);
}

// Fallback hero fill from the live snapshot (if the Riot analytics aren't ready).
function applyLastGame(d) {
  if (!d || !d.scores) return;
  if (!$("c-champ").textContent || $("c-champ").textContent === "—" || $("c-champ").textContent === "No game") {
    const s = d.scores;
    const kda = s.kda || { k: 0, d: 0, a: 0 };
    fillHero({ champion: s.champion, champKey: s.champion, win: s.win, k: kda.k, d: kda.d, a: kda.a,
      kda: kda.d ? +(((kda.k + kda.a) / kda.d).toFixed(2)) : kda.k + kda.a,
      cs: s.cs, csPerMin: s.csPerMin, gold: s.gold, durationSec: s.gameTime });
  }
  renderCoachStatus(d.coach);
}

function renderCoachStatus(coach) {
  if (coach && coach.ready === false) {
    coachWarn.textContent = coach.message || "AI coach unavailable.";
    coachWarn.hidden = false; coachBtn.disabled = true;
  } else if (coach && coach.ready === true) {
    coachWarn.hidden = true;
    if (!out.classList.contains("streaming")) coachBtn.disabled = false;
  }
}

/* ---- Markdown rendering (safe, minimal) ---- */
function mdReview(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*_])[*_]([^*_]+)[*_](?!\*)/g, "$1<em>$2</em>");
  const html = [];
  for (let block of String(src || "").trim().split(/\n{2,}/)) {
    block = block.trim(); if (!block || /^-{3,}$/.test(block)) continue;
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) html.push("<ul>" + lines.map((l) => "<li>" + inline(l.replace(/^\s*[-*]\s+/, "")) + "</li>").join("") + "</ul>");
    else html.push("<p>" + lines.map((l) => { const h = l.match(/^(#{1,4})\s+(.*)$/); if (h) { const n = h[1].length; return `</p><h${n + 1}>` + inline(h[2]) + `</h${n + 1}><p>`; } return inline(l); }).join("<br>") + "</p>");
  }
  return html.join("").replace(/<p><\/p>/g, "");
}

/* ---- Streaming AI review ---- */
let coachRaw = "";
const api = window.pepstats; // the preload bridge; absent only in standalone preview
coachBtn.addEventListener("click", () => {
  coachBtn.disabled = true; coachRaw = ""; out.innerHTML = ""; out.classList.add("streaming");
  if (api && api.startCoach) api.startCoach();
});

/* ---- Init ---- */
wireGSEHover();
if (api) {
  api.onCoachChunk((text) => { coachRaw += text; out.innerHTML = mdReview(coachRaw); out.scrollTop = out.scrollHeight; });
  api.onCoachDone(() => { out.innerHTML = mdReview(coachRaw); coachBtn.disabled = false; out.classList.remove("streaming"); });
  api.onCoachError((msg) => { out.textContent = msg; coachBtn.disabled = false; out.classList.remove("streaming"); });
  api.onLastGame(applyLastGame); // pushed when a match ends
  (async () => {
    try { applyLastGame(await api.getLastGame()); } catch (_) {}
    try { applyPostgame(await api.getPostgame()); } catch (_) {}
  })();
}
