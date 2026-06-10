"use strict";

const $ = (id) => document.getElementById(id);
const api = window.pepstats || {};

// Minimal, safe Markdown renderer for short AI advice blocks. Escapes HTML first,
// then supports **bold**, *italic*, `-`/`*` bullet lists and paragraph breaks.
function mdLite(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  const blocks = String(src || "").trim().split(/\n{2,}/);
  let html = "";
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      html += "<ul>" + lines.map((l) => "<li>" + inline(l.replace(/^\s*[-*]\s+/, "")) + "</li>").join("") + "</ul>";
    } else {
      html += "<p>" + lines.map(inline).join("<br>") + "</p>";
    }
  }
  return html;
}
// Render { text } | { error } into an AI output element as formatted HTML.
function renderAiOut(out, res, fallback) {
  out.classList.remove("loading");
  if (res && res.text) out.innerHTML = mdLite(res.text);
  else out.textContent = (res && res.error) || fallback;
}

// ---- Window controls (setup + app) ----
for (const id of ["su-min", "tb-min"]) { const el = $(id); if (el) el.addEventListener("click", () => api.winMin && api.winMin()); }
for (const id of ["su-close", "tb-close"]) { const el = $(id); if (el) el.addEventListener("click", () => api.winClose && api.winClose()); }

// ---- Navigation ----
const PAGE_META = {
  dashboard: ["Dashboard", "Your ranked snapshot"],
  progress: ["Progress", "Climb history & trends"],
  tft: ["TFT", "Teamfight Tactics history"],
  friends: ["Friends", "Live status & recent games"],
  settings: ["Settings", "Account, AI & appearance"],
};
document.querySelectorAll(".nav-item").forEach((b) => {
  b.addEventListener("click", () => {
    const page = b.dataset.page;
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n === b));
    document.querySelectorAll(".page").forEach((p) => p.classList.toggle("hidden", p.id !== "page-" + page));
    const meta = PAGE_META[page] || ["", ""];
    $("page-title").textContent = meta[0];
    $("page-sub").textContent = meta[1];
    if (page === "progress" && !matchesLoaded) loadMatches();
    if (page === "tft" && !tftLoaded) loadTft();
    friendsActive = page === "friends";
    if (friendsActive) startFriends();
  });
});
// "View all →" style shortcuts that jump to another page.
document.querySelectorAll("[data-goto]").forEach((el) => {
  el.addEventListener("click", () => {
    const target = document.querySelector(`.nav-item[data-page="${el.dataset.goto}"]`);
    if (target) target.click();
  });
});

// ---- Helpers ----
const PHASE_LABEL = {
  None: "Idle", Lobby: "In lobby", Matchmaking: "In queue", ReadyCheck: "Ready check",
  ChampSelect: "Champ select", InProgress: "In game", WaitingForStats: "Loading results",
  PreEndOfGame: "Post-game", EndOfGame: "Post-game",
};
const signedLp = (n) => (n == null ? "—" : (n >= 0 ? "+" : "−") + Math.abs(n));
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : "");

let lastHome = null;
let ddVersion = null;
let currentRunes = null;
let matchCount = 20;

// Real rank emblems (CommunityDragon mini-crests).
const rankEmblem = (tier) =>
  tier ? `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests/${tier.toLowerCase()}.png` : null;
function setEmblem(el, tier, fallback) {
  if (!el) return;
  el.textContent = "";
  if (tier) {
    const img = document.createElement("img");
    img.className = "emblem-img";
    img.src = rankEmblem(tier);
    img.onerror = () => { el.textContent = tier[0] || fallback || "?"; };
    el.appendChild(img);
  } else {
    el.textContent = fallback || "?";
  }
}

// Summoner spell id -> Data Dragon image name.
const SPELLS = {
  1: "SummonerBoost", 3: "SummonerExhaust", 4: "SummonerFlash", 6: "SummonerHaste",
  7: "SummonerHeal", 11: "SummonerSmite", 12: "SummonerTeleport", 13: "SummonerMana",
  14: "SummonerDot", 21: "SummonerBarrier", 30: "SummonerPoroRecall", 31: "SummonerPoroThrow",
  32: "SummonerSnowball", 39: "SummonerSnowURFSnowball_Mark",
};
const spellImg = (ver, id) => (SPELLS[id] ? `https://ddragon.leagueoflegends.com/cdn/${ver}/img/spell/${SPELLS[id]}.png` : null);

// ===== Setup =====
let regionsLoaded = false;
async function loadRegions() {
  if (regionsLoaded || !api.getRiotRegions) return;
  try {
    const regions = await api.getRiotRegions();
    const sel = $("su-region"); sel.innerHTML = "";
    for (const r of regions || []) { const o = document.createElement("option"); o.value = r.code; o.textContent = r.label + " (" + r.code + ")"; sel.append(o); }
    regionsLoaded = true;
  } catch (_) {}
}
// Probe the running League client and surface the one-click connect option
// (and pre-fill the manual fields) when an account is readable.
let setupProbeTimer = null;
async function probeClientAccount() {
  if (!api.clientAccount) return;
  let res; try { res = await api.clientAccount(); } catch (_) { res = null; }
  const box = $("su-client-box"), hint = $("su-client-hint");
  if (res && res.available) {
    box.classList.remove("hidden"); hint.classList.add("hidden");
    $("su-client-name").textContent = res.riotId || res.name || "";
    if (res.riotId && !$("su-riotid").value) $("su-riotid").value = res.riotId;
    if (res.region) loadRegions().then(() => { if (res.region && !$("su-region").value) $("su-region").value = res.region; });
  } else {
    box.classList.add("hidden"); hint.classList.remove("hidden");
  }
}
function showSetup(show) {
  $("setup").classList.toggle("hidden", !show);
  $("app").classList.toggle("hidden", show);
  if (show) {
    loadRegions();
    probeClientAccount();
    // Re-probe while the setup screen is open so opening League mid-setup updates it.
    if (!setupProbeTimer) setupProbeTimer = setInterval(probeClientAccount, 3500);
  } else if (setupProbeTimer) {
    clearInterval(setupProbeTimer);
    setupProbeTimer = null;
  }
}
// One-click: connect from the running client (saves the account, no key needed).
$("su-client").addEventListener("click", async () => {
  const btn = $("su-client"), err = $("su-error");
  err.classList.add("hidden"); btn.disabled = true; const prev = btn.textContent; btn.textContent = "Connecting…";
  try {
    const res = await api.connectClient();
    if (res && res.ok) { showSetup(false); refresh(); }
    else { err.textContent = (res && res.error) || "Couldn't connect via the League client."; err.classList.remove("hidden"); }
  } catch (e) { err.textContent = "Connection failed: " + (e && e.message ? e.message : "error"); err.classList.remove("hidden"); }
  finally { btn.disabled = false; btn.textContent = prev; }
});
$("su-connect").addEventListener("click", async () => {
  const btn = $("su-connect"), err = $("su-error");
  err.classList.add("hidden"); btn.disabled = true; const prev = btn.textContent; btn.textContent = "Connecting…";
  try {
    const res = await api.connectRiot({ riotId: $("su-riotid").value, region: $("su-region").value, riotApiKey: $("su-key").value });
    if (res && res.ok) { showSetup(false); refresh(); }
    else { err.textContent = (res && res.error) || "Couldn't connect. Check your details, or use the League client above."; err.classList.remove("hidden"); }
  } catch (e) { err.textContent = "Connection failed: " + (e && e.message ? e.message : "error"); err.classList.remove("hidden"); }
  finally { btn.disabled = false; btn.textContent = prev; }
});
$("su-skip").addEventListener("click", async () => { try { await api.skipRiot(); } catch (_) {} showSetup(false); refresh(); });

// ===== Render =====
let lastSettings = null;
function render(data) {
  if (!data) return;
  if (data.needsSetup) { showSetup(true); return; }
  showSetup(false);
  const { summary, status, settings, lastMatch } = data;
  lastSettings = settings;
  lastHome = data;
  applyAiGate(!!data.hasAiKey); // hide all AI features until the user adds a Claude key

  const p = (summary && summary.progress) || {};
  const solo = summary && summary.solo;
  const sm = summary && summary.summoner;

  // Rank chip (rail)
  setEmblem($("rc-em"), solo && solo.tier, "?");
  $("rc-tx").textContent = p.label || "Unranked";

  // Hero
  $("rank-now").textContent = p.label || "Unranked";
  setEmblem($("emblem-letter"), solo && solo.tier, "?");
  $("rank-next").textContent = p.next ? "Next: " + p.next : "Play ranked to start tracking";
  const div = p.division || { pct: 0, lp: 0, toNext: 100 };
  $("lp-fill").style.width = (solo ? div.pct : 0) + "%";
  $("lp-text").textContent = solo ? `${div.lp} LP` : "Unranked";
  // Circular progress ring around the emblem + the letter-spaced W-L-WR line.
  const ring = $("rank-ring"); if (ring) ring.style.setProperty("--lp-pct", String(solo ? (div.pct || 0) : 0));
  const wlEl = $("rank-wl");
  if (wlEl) {
    if (solo) wlEl.innerHTML = `<b>${solo.wins || 0}</b>W <b>${solo.losses || 0}</b>L · <b>${p.winRate != null ? p.winRate + "%" : "—"}</b>`;
    else wlEl.textContent = "Play ranked to start tracking";
  }

  // KPIs
  const wk = (summary && summary.weekly) || {};
  // kpi-weekly is now a <b> inside an .rk cell — color via pos/neg only, and
  // don't fight the .rk b sizing with the old .kpi-val class.
  const wkEl = $("kpi-weekly");
  if (wk.tracking || wk.gain == null) { wkEl.textContent = "tracking…"; wkEl.className = ""; wkEl.style.fontSize = "11px"; }
  else { wkEl.textContent = signedLp(wk.gain) + " LP"; wkEl.className = wk.gain > 0 ? "pos" : wk.gain < 0 ? "neg" : ""; wkEl.style.fontSize = ""; }
  $("kpi-level").textContent = sm && sm.level ? sm.level : "—";
  $("kpi-wr").textContent = p.winRate != null ? p.winRate + "%" : "—";

  // Connection + status
  const up = status && status.clientUp;
  $("conn-dot").className = "conn-dot " + (up ? "on" : "off");
  $("conn-tx").textContent = up ? "Connected" : "Offline";
  const cl = $("st-client"); cl.textContent = up ? "Connected" : "Offline"; cl.className = "pill " + (up ? "on" : "off");
  $("st-phase").textContent = (status && PHASE_LABEL[status.phase]) || "Idle";
  $("st-summoner").textContent = sm && sm.name ? sm.name + (sm.tagLine ? "#" + sm.tagLine : "") : "—";

  // Last match
  if (lastMatch && lastMatch.champion) {
    $("lm-empty").classList.add("hidden"); $("lm-body").classList.remove("hidden");
    $("lm-champ").textContent = lastMatch.champion;
    const k = lastMatch.kda || { k: 0, d: 0, a: 0 };
    $("lm-kda").textContent = `${k.k} / ${k.d} / ${k.a}`;
    $("lm-cs").textContent = `${Math.round(lastMatch.cs || 0)} (${(lastMatch.csPerMin || 0).toFixed(1)}/min)`;
  } else { $("lm-empty").classList.remove("hidden"); $("lm-body").classList.add("hidden"); }

  // Progress: ranked summary card (match list loads on demand)
  setEmblem($("rs-em"), solo && solo.tier, "?");
  $("rs-tier").textContent = p.label || "Unranked";
  $("rs-lp").textContent = solo ? `${div.lp} LP` : "—";
  $("rs-wr").textContent = solo ? `${p.winRate != null ? p.winRate + "% WR" : "—"} · ${p.wins}W ${p.losses}L` : "—";

  // Ranked Flex
  const flex = summary && summary.ranked && summary.ranked.flex;
  setEmblem($("fx-em"), flex && flex.tier, "?");
  $("fx-tier").textContent = flex && flex.tier ? cap(flex.tier) + " " + (flex.division || "") : "Unranked";
  $("fx-lp").textContent = flex ? `${flex.lp} LP · ${flex.wins}W ${flex.losses}L` : "—";

  // Profile header + LP graph
  $("prof-name").textContent = sm && sm.name ? sm.name + (sm.tagLine ? " #" + sm.tagLine : "") : "—";
  $("prof-lvl").textContent = "Level " + (sm && sm.level ? sm.level : "—");
  updateProfileIcon();
  drawLpGraph(data.history || []);
  drawLpGraph(data.history || [], { empty: "db-lp-empty", svg: "db-lp-graph", line: "db-lp-line" });

  // Settings: account + AI fields
  $("set-riotid").textContent = (settings && settings.riotId) || "Not linked";
  $("set-region").textContent = (settings && settings.region) || "—";
  $("set-level").textContent = sm && sm.level ? sm.level : "—";
  if (!settingsDirty) {
    if (document.activeElement !== $("set-key")) $("set-key").value = (settings && settings.anthropicApiKey) || "";
    if (document.activeElement !== $("set-baseline")) $("set-baseline").value = (settings && settings.baselineApiUrl) || "";
    setClaudeMode(!!(settings && settings.coachUseClaude));
    ovDesignMode = !!(settings && settings.overlayDefaultDesign);
    setSeg("seg-ovdesign", ovDesignMode ? "on" : "off");
    if (settings && settings.matchCount) { const mc = $("set-mhcount"); if (mc) mc.value = String(settings.matchCount); if (!matchesLoaded) matchCount = settings.matchCount; }
  }

  // Dashboard extras (recent matches, champ pool, quick stats) — fetched once.
  loadDashboardExtras();
}

// Generic segmented-control state setter.
function setSeg(id, value) {
  const el = $(id); if (!el) return;
  el.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === value));
}

// ===== Dashboard extras =====
let dashLoaded = false;
let dashLastTry = 0;
async function loadDashboardExtras(force) {
  if ((dashLoaded && !force) || !api.getMatches) return;
  // Throttle retries (the render loop ticks every 5s; don't hammer the API while
  // offline or rate-limited).
  const now = Date.now();
  if (!force && now - dashLastTry < 30000) return;
  dashLastTry = now;
  let res;
  try { res = await api.getMatches("all", 10); } catch (_) { return; }
  if (!res || !res.ok) return;
  dashLoaded = true;
  const ver = res.version;
  const matches = res.matches || [];

  // Quick stats
  const s = res.summary || {};
  const recEl = $("qs-record"); if (recEl) recEl.textContent = s.games ? `${s.w}W ${s.l}L` : "—";
  const kdaEl = $("qs-kda"); if (kdaEl) kdaEl.textContent = s.games ? (s.kda + " KDA") : "—";
  const csEl = $("qs-cs");
  if (csEl) { const avgCs = matches.length ? (matches.reduce((t, m) => t + (m.csPerMin || 0), 0) / matches.length) : 0; csEl.textContent = matches.length ? avgCs.toFixed(1) : "—"; }
  const champs = res.champs || [];
  const mainEl = $("qs-main"); if (mainEl) mainEl.textContent = champs.length ? champs[0].champion : "—";

  // Recent matches — dense Blitz feed (up to 10), 5 aligned columns per row.
  const list = $("db-recent"), empty = $("db-recent-empty");
  if (list && empty) {
    const recent = matches.slice(0, 10);
    if (!recent.length) { empty.classList.remove("hidden"); list.classList.add("hidden"); }
    else {
      empty.classList.add("hidden"); list.classList.remove("hidden"); list.innerHTML = "";
      for (const m of recent) list.append(buildMatchRow(m, ver));
    }
  }

  // Performance — top champions (icon, name, KDA, WR, real W-L).
  const cpList = $("db-champs"), cpEmpty = $("db-champs-empty");
  if (cpList && cpEmpty) {
    if (!champs.length) { cpEmpty.classList.remove("hidden"); cpList.classList.add("hidden"); }
    else {
      cpEmpty.classList.add("hidden"); cpList.classList.remove("hidden"); cpList.innerHTML = "";
      for (const c of champs.slice(0, 5)) {
        const w = Math.round((c.games * c.wr) / 100), l = Math.max(0, c.games - w);
        const li = document.createElement("li"); li.className = "perf-row";
        li.innerHTML =
          `<span class="perf-ico-slot"></span>` +
          `<div class="perf-meta"><span class="perf-name">${c.champion}</span><span class="perf-sub">${c.kda} KDA · ${c.games} games</span></div>` +
          `<div class="perf-right"><div class="perf-wr ${c.wr >= 50 ? "pos" : "neg"}">${c.wr}%</div><div class="perf-rec">${w}W ${l}L</div></div>`;
        const slot = li.querySelector(".perf-ico-slot");
        if (slot) slot.replaceWith(mkImg(champImg(ver, c.champKey), "perf-ico", function () { this.style.visibility = "hidden"; }));
        cpList.append(li);
      }
    }
  }
}

// A heuristic per-match performance grade (Riot exposes no official grade). Blends
// KDA, kill participation, CS/min, damage share and vision into a letter tier.
function matchGrade(m) {
  let s = 34;
  s += ((m.kda || 0) - 2.5) * 7;
  // LCU-sourced rows lack KP%/damage-share (no full lobby) — score those terms
  // as neutral instead of zero so keyless grades aren't unfairly tanked.
  s += ((typeof m.kp === "number" ? m.kp : 50) - 50) * 0.35;
  s += ((m.csPerMin || 0) - 6) * 3.5;
  s += ((typeof m.dmgShare === "number" ? m.dmgShare : 20) - 20) * 0.5;
  s += Math.min(12, (m.vision || 0) * 0.25);
  s += m.win ? 6 : -3;
  s = Math.max(0, Math.min(100, s));
  const t = [[88, "S"], [80, "A+"], [72, "A"], [63, "A-"], [54, "B+"], [45, "B"], [36, "B-"], [27, "C+"], [18, "C"], [0, "D"]];
  return (t.find((x) => s >= x[0]) || [0, "D"])[1];
}
const ROLE_LBL = { TOP: "TOP", JUNGLE: "JNG", MIDDLE: "MID", BOTTOM: "ADC", UTILITY: "SUP" };

function buildMatchRow(m, ver) {
  const li = document.createElement("li");
  li.className = "match-row " + (m.remake ? "remake" : (m.win ? "win" : "loss"));
  const durMin = Math.max(1, (m.durationSec || 0) / 60);
  const visMin = (m.vision / durMin).toFixed(1);
  const dmgMin = Math.round(m.dmg / durMin);
  const grade = matchGrade(m);
  const role = ROLE_LBL[m.position] || (m.position ? m.position.slice(0, 3) : "—");
  const resTxt = m.remake ? "Remake" : (m.win ? "Victory" : "Defeat");
  li.innerHTML =
    `<div class="mr-status"><span class="mr-champ-slot"></span>` +
      `<div class="mr-st"><span class="mr-res">${resTxt}</span>` +
        `<span class="mr-kda"><b>${m.k}</b>/<b class="d">${m.d}</b>/<b>${m.a}</b></span>` +
        `<span class="mr-kdar">${m.kda} KDA</span></div></div>` +
    `<div class="mr-col"><span class="mr-k">Vis/Min</span><b>${visMin}</b><span class="mr-sub">${typeof m.kp === "number" ? m.kp + "% KP" : "—"}</span></div>` +
    `<div class="mr-col"><span class="mr-k">CS/Min</span><b>${m.csPerMin}</b><span class="mr-sub">${m.cs} CS</span></div>` +
    `<div class="mr-grade-col"><span class="mr-grade g-${grade[0]}">${grade}</span>` +
      `<div class="mr-dmg"><span class="mr-k">Dmg/Min</span><b>${kFmt(dmgMin)}</b><span class="mr-sub">${typeof m.dmgShare === "number" ? m.dmgShare + "% of team" : "—"}</span></div></div>` +
    `<div class="mr-meta"><span class="mr-role">${role}</span><span>${m.queue || "Game"}</span><span>${timeAgo(m.endTs)}</span></div>`;
  const slot = li.querySelector(".mr-champ-slot");
  if (slot) slot.replaceWith(mkImg(champImg(ver, m.champKey), "mr-champ", function () { this.style.visibility = "hidden"; }));
  return li;
}

// ===== Match history (Progress page) =====
let progressSummary = null;
let matchFilter = "all";
let matchesLoaded = false;
let filtersBuilt = false;
let lastMatches = [];

const champImg = (ver, key) => `https://ddragon.leagueoflegends.com/cdn/${ver}/img/champion/${key}.png`;
const itemImg = (ver, id) => `https://ddragon.leagueoflegends.com/cdn/${ver}/img/item/${id}.png`;

function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  const d = Math.floor(s / 86400);
  if (d < 14) return d + "d ago";
  return Math.floor(d / 7) + "w ago";
}
const dur = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
const kFmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

function updateProfileIcon() {
  const sm = lastHome && lastHome.summary && lastHome.summary.summoner;
  const el = $("prof-icon");
  if (el && sm && sm.profileIconId != null && ddVersion) {
    el.src = `https://ddragon.leagueoflegends.com/cdn/${ddVersion}/img/profileicon/${sm.profileIconId}.png`;
    el.style.visibility = "visible";
  } else if (el) { el.style.visibility = "hidden"; }
}

function drawLpGraph(history, ids) {
  ids = ids || { empty: "lp-graph-empty", svg: "lp-graph", line: "lp-line" };
  const pts = (history || []).filter((e) => typeof e.score === "number");
  const empty = $(ids.empty), svg = $(ids.svg), line = $(ids.line);
  if (!empty || !svg || !line) return;
  if (pts.length < 2) { empty.classList.remove("hidden"); svg.classList.add("hidden"); return; }
  empty.classList.add("hidden"); svg.classList.remove("hidden");
  const scores = pts.map((e) => e.score);
  let min = Math.min(...scores), max = Math.max(...scores);
  if (max === min) { max += 1; min -= 1; }
  // Read the drawing space from the SVG itself — the dashboard sparkline is
  // 240x60 while the Progress graph is 240x90; hardcoding clips the shorter one.
  const vb = svg.viewBox && svg.viewBox.baseVal;
  const W = (vb && vb.width) || 240, H = (vb && vb.height) || 90, pad = 8, n = pts.length;
  const xs = (i) => pad + (i / (n - 1)) * (W - 2 * pad);
  const ys = (v) => pad + (1 - (v - min) / (max - min)) * (H - 2 * pad);
  line.setAttribute("points", pts.map((e, i) => `${xs(i).toFixed(1)},${ys(e.score).toFixed(1)}`).join(" "));
}

async function buildFilters() {
  if (filtersBuilt || !api.getMatchFilters) return;
  try {
    const fs = await api.getMatchFilters();
    const sel = $("mh-filter"); sel.innerHTML = "";
    for (const f of fs || []) { const o = document.createElement("option"); o.value = f.key; o.textContent = f.label; sel.append(o); }
    sel.value = matchFilter;
    sel.addEventListener("change", () => { matchFilter = sel.value; matchCount = 20; loadMatches(); });
    filtersBuilt = true;
  } catch (_) {}
  const more = $("mh-more");
  if (more && !more._wired) { more._wired = true; more.addEventListener("click", () => { matchCount += 10; loadMatches(); }); }
  const exp = $("mh-export");
  if (exp && !exp._wired) {
    exp._wired = true;
    exp.addEventListener("click", async () => {
      if (!lastMatches.length || !api.exportMatches) return;
      const prev = exp.textContent; exp.disabled = true; exp.textContent = "Exporting…";
      try {
        const res = await api.exportMatches({ matches: lastMatches, filter: matchFilter });
        exp.textContent = res && res.ok ? "Exported ✓" : (res && res.canceled ? prev : "Export failed");
      } catch (_) { exp.textContent = "Export failed"; }
      finally { exp.disabled = false; setTimeout(() => { exp.textContent = prev; }, 1800); }
    });
  }
}

async function loadMatches() {
  await buildFilters();
  const loading = $("mh-loading"), empty = $("mh-empty"), list = $("mh-list"), more = $("mh-more");
  loading.classList.remove("hidden"); empty.classList.add("hidden");
  more.disabled = true;
  try {
    const res = await api.getMatches(matchFilter, matchCount);
    loading.classList.add("hidden"); more.disabled = false;
    if (!res || !res.ok) { list.classList.add("hidden"); more.classList.add("hidden"); empty.classList.remove("hidden"); empty.textContent = (res && res.error) || "Couldn't load matches."; return; }
    renderMatches(res);
    matchesLoaded = true;
  } catch (e) { loading.classList.add("hidden"); list.classList.add("hidden"); more.classList.add("hidden"); empty.classList.remove("hidden"); empty.textContent = "Couldn't load matches."; }
}

const mkImg = (src, cls, onerr) => { const i = document.createElement("img"); if (cls) i.className = cls; i.src = src; i.onerror = onerr; return i; };

// Achievement badges derived from the match's REAL participant data.
function matchBadges(m) {
  const out = [];
  const parts = m.participants || [];
  const meP = parts.find((p) => p.me);
  const kdaOf = (p) => (p.d ? (p.k + p.a) / p.d : p.k + p.a);
  if (meP) {
    const team = parts.filter((p) => p.teamId === meP.teamId);
    const all = parts.slice();
    const bestTeam = team.reduce((a, b) => (kdaOf(b) > kdaOf(a) ? b : a), team[0]);
    const bestAll = all.reduce((a, b) => (kdaOf(b) > kdaOf(a) ? b : a), all[0]);
    if (bestAll && bestAll.me) out.push({ t: "ACE", cls: "gold" });
    else if (bestTeam && bestTeam.me) out.push({ t: m.win ? "MVP" : "SVP", cls: "gold" });
    // Most CS on own team.
    const topCs = team.reduce((a, b) => ((b.cs || 0) > (a.cs || 0) ? b : a), team[0]);
    if (topCs && topCs.me) out.push({ t: "High CS", cls: "silver" });
  }
  if (out.length < 2 && typeof m.kp === "number" && m.kp >= 65) out.push({ t: "Playmaker", cls: "silver" });
  if (out.length < 2 && typeof m.kda === "number" && m.kda >= 5) out.push({ t: m.kda + " KDA", cls: "gold" });
  return out.slice(0, 2);
}

// Right-column analytics — all from the player's own match data.
let analyticsChampKey = "";
function renderAnalytics(res, ver) {
  const matches = (res.matches || []).filter((m) => !m.remake);

  // ---- GPM vs average (oldest -> newest), from the player's own gold ----
  const series = [];
  for (const m of matches.slice().reverse()) {
    const meP = (m.participants || []).find((p) => p.me);
    const gold = meP ? meP.gold : 0;
    const mins = m.durationSec ? m.durationSec / 60 : 0;
    if (gold && mins) series.push(Math.round(gold / mins));
  }
  const gEmpty = $("an-gpm-empty"), gSvg = $("an-gpm"), gLine = $("an-gpm-line"), gAvg = $("an-gpm-avg"), gLeg = $("an-gpm-legend");
  if (series.length < 2) {
    gEmpty.classList.remove("hidden"); gSvg.classList.add("hidden"); gLeg.classList.add("hidden");
  } else {
    gEmpty.classList.add("hidden"); gSvg.classList.remove("hidden"); gLeg.classList.remove("hidden");
    const avg = Math.round(series.reduce((a, b) => a + b, 0) / series.length);
    let min = Math.min(...series), max = Math.max(...series);
    if (max === min) { max += 1; min -= 1; }
    const W = 240, H = 96, pad = 8, n = series.length;
    const xs = (i) => pad + (i / (n - 1)) * (W - 2 * pad);
    const ys = (v) => pad + (1 - (v - min) / (max - min)) * (H - 2 * pad);
    gLine.setAttribute("points", series.map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(" "));
    const ay = ys(avg).toFixed(1); gAvg.setAttribute("y1", ay); gAvg.setAttribute("y2", ay);
    $("an-gpm-avgval").textContent = avg + " g/m";
  }

  // ---- Skill maxing order for the most-played champion ----
  const champs = res.champs || [];
  const top = champs[0];
  const sEmpty = $("an-skill-empty"), sBox = $("an-skill"), sChamp = $("an-skill-champ");
  if (top && top.champKey && top.champKey !== analyticsChampKey) {
    analyticsChampKey = top.champKey;
    sChamp.textContent = top.champion;
    if (api.getBuildByKey) {
      api.getBuildByKey(top.champKey).then((b) => {
        if (!b || !b.skills || !b.skills.length) { sEmpty.classList.remove("hidden"); sBox.classList.add("hidden"); return; }
        sEmpty.classList.add("hidden"); sBox.classList.remove("hidden"); sBox.innerHTML = "";
        sChamp.textContent = top.champion + (b.source === "riot" ? " · from your games" : " · curated");
        const widths = [100, 70, 45];
        b.skills.forEach((sk, i) => {
          const row = document.createElement("div"); row.className = "an-skrow";
          const key = document.createElement("span"); key.className = "an-skkey"; key.textContent = sk;
          const bar = document.createElement("div"); bar.className = "an-skbar";
          const fill = document.createElement("div"); fill.className = "an-skfill"; fill.style.width = (widths[i] || 30) + "%";
          bar.append(fill);
          const ord = document.createElement("span"); ord.className = "an-skord"; ord.textContent = i === 0 ? "Max 1st" : i === 1 ? "2nd" : "3rd";
          row.append(key, bar, ord); sBox.append(row);
        });
        // Full 1–15 level path (only when derived from real games).
        if (Array.isArray(b.skillPath) && b.skillPath.length) {
          const path = document.createElement("div"); path.className = "an-skpath";
          b.skillPath.slice(0, 15).forEach((sk, i) => {
            const cell = document.createElement("span");
            cell.className = "an-skcell s-" + sk;
            cell.textContent = sk;
            cell.title = "Level " + (i + 1);
            path.append(cell);
          });
          sBox.append(path);
        }
      }).catch(() => { sEmpty.classList.remove("hidden"); sBox.classList.add("hidden"); });
    }
  } else if (!top) {
    analyticsChampKey = ""; sChamp.textContent = "Most-played champion"; sEmpty.classList.remove("hidden"); sBox.classList.add("hidden");
  }

  // ---- Best & worst champions from the player's own win rates ----
  const ranked = champs.filter((c) => c.games >= 2).sort((a, b) => b.wr - a.wr);
  const bwEmpty = $("an-bw-empty"), bw = $("an-bw");
  if (ranked.length < 1) { bwEmpty.classList.remove("hidden"); bw.classList.add("hidden"); }
  else {
    bwEmpty.classList.add("hidden"); bw.classList.remove("hidden"); bw.innerHTML = "";
    const rows = [{ tag: "Best", c: ranked[0] }];
    if (ranked.length > 1) rows.push({ tag: "Worst", c: ranked[ranked.length - 1] });
    for (const r of rows) {
      const li = document.createElement("li");
      li.append(mkImg(champImg(ver, r.c.champKey), "an-bwico", function () { this.style.visibility = "hidden"; }));
      const meta = document.createElement("div"); meta.className = "an-bwmeta";
      meta.innerHTML = `<span class="an-bwtag ${r.tag === "Best" ? "pos" : "neg"}">${r.tag}</span> ${r.c.champion}<span class="an-bwsub">${r.c.games} games · ${r.c.kda} KDA</span>`;
      const wr = document.createElement("div"); wr.className = "an-bwwr " + (r.c.wr >= 50 ? "pos" : "neg"); wr.textContent = r.c.wr + "%";
      li.append(meta, wr); bw.append(li);
    }
  }
}

function buildDetail(m, ver) {
  const wrap = document.createElement("div"); wrap.className = "m-detail hidden";
  const maxDmg = Math.max(1, ...m.participants.map((p) => p.dmg || 0));
  const runes = currentRunes || { perks: {}, styles: {} };

  for (const tid of [100, 200]) {
    const teamP = m.participants.filter((p) => p.teamId === tid);
    if (!teamP.length) continue;
    const td = (m.teams || []).find((x) => x.teamId === tid) || {};
    const won = teamP[0].win;
    const k = teamP.reduce((s, p) => s + p.k, 0);
    const d = teamP.reduce((s, p) => s + p.d, 0);
    const a = teamP.reduce((s, p) => s + p.a, 0);
    const gold = teamP.reduce((s, p) => s + (p.gold || 0), 0);

    const team = document.createElement("div"); team.className = "sb-team " + (won ? "win" : "loss");
    const head = document.createElement("div"); head.className = "sb-head";
    const objBits = [];
    if (td.tower) objBits.push(`⌂ ${td.tower}`);
    if (td.dragon) objBits.push(`🐉 ${td.dragon}`);
    if (td.baron) objBits.push(`Ω ${td.baron}`);
    if (td.grubs) objBits.push(`◆ ${td.grubs}`);
    head.innerHTML =
      `<span class="sb-res">${won ? "Victory" : "Defeat"}</span>` +
      `<span class="sb-tot">${k} / ${d} / ${a}</span>` +
      (objBits.length ? `<span class="sb-obj">${objBits.join("  ")}</span>` : "") +
      `<span class="sb-gold">${kFmt(gold)} gold</span>`;
    team.append(head);

    for (const p of teamP) {
      const row = document.createElement("div"); row.className = "sb-row" + (p.me ? " me" : "");

      const champ = document.createElement("div"); champ.className = "sb-champwrap";
      champ.append(mkImg(champImg(ver, p.champKey), "sb-champ", function () { this.style.visibility = "hidden"; }));
      const lvl = document.createElement("span"); lvl.className = "sb-lvl"; lvl.textContent = p.champLevel || "";
      champ.append(lvl);

      const sr = document.createElement("div"); sr.className = "sb-sr";
      const spellsCol = document.createElement("div"); spellsCol.className = "sb-col";
      for (const sid of (p.spells || [])) { const c = document.createElement("span"); c.className = "sb-mini"; const u = spellImg(ver, sid); if (u) c.append(mkImg(u, "", function () { c.classList.add("empty"); })); else c.classList.add("empty"); spellsCol.append(c); }
      const runeCol = document.createElement("div"); runeCol.className = "sb-col";
      const kImg = runes.perks && runes.perks[p.keystone];
      const rc = document.createElement("span"); rc.className = "sb-mini round"; if (kImg) rc.append(mkImg(kImg, "", function () { rc.classList.add("empty"); })); else rc.classList.add("empty"); runeCol.append(rc);
      sr.append(spellsCol, runeCol);

      const info = document.createElement("div"); info.className = "sb-info";
      const nm = document.createElement("div"); nm.className = "sb-name"; nm.textContent = p.name || p.champion;
      const kd = document.createElement("div"); kd.className = "sb-kda";
      const ratio = p.d ? ((p.k + p.a) / p.d).toFixed(1) : p.k + p.a;
      kd.innerHTML = `<b>${p.k}/${p.d}/${p.a}</b> <span>${ratio} KDA · ${p.kp}% KP</span>`;
      info.append(nm, kd);

      const items = document.createElement("div"); items.className = "sb-items";
      for (const it of (p.items || [])) { const c = document.createElement("span"); c.className = "sb-item"; if (it) c.append(mkImg(itemImg(ver, it), "", function () { c.classList.add("empty"); })); else c.classList.add("empty"); items.append(c); }

      const cs = document.createElement("div"); cs.className = "sb-cs"; cs.textContent = `${p.cs} CS`;

      const dmg = document.createElement("div"); dmg.className = "sb-dmg";
      dmg.innerHTML = `<div class="sb-dmgnum">${kFmt(p.dmg)}</div><div class="sb-bar"><div class="sb-fill" style="width:${Math.round((p.dmg / maxDmg) * 100)}%"></div></div>`;

      row.append(champ, sr, info, items, cs, dmg);
      team.append(row);
    }
    wrap.append(team);
  }
  return wrap;
}

function renderMatches(res) {
  const ver = res.version, list = $("mh-list");
  ddVersion = ver; currentRunes = res.runes || { perks: {}, styles: {} };
  lastMatches = res.matches || [];
  updateProfileIcon();

  const s = res.summary || { w: 0, l: 0, games: 0, kda: 0 };
  $("mh-summary").textContent = s.games ? `Last ${s.games} · ${s.w}W ${s.l}L · ${s.kda} KDA` : "No ranked games";

  // champion performance
  const cp = $("cp-list"); cp.innerHTML = "";
  const champs = res.champs || [];
  $("cp-empty").classList.toggle("hidden", champs.length > 0);
  cp.classList.toggle("hidden", champs.length === 0);
  for (const c of champs) {
    const li = document.createElement("li");
    li.append(mkImg(champImg(ver, c.champKey), "cp-icon", function () { this.style.visibility = "hidden"; }));
    const name = document.createElement("div"); name.className = "cp-name"; name.innerHTML = `${c.champion}<span class="cp-sub">${c.games} games · ${c.kda} KDA</span>`;
    const wr = document.createElement("div"); wr.className = "cp-wr " + (c.wr >= 50 ? "pos" : "neg"); wr.textContent = c.wr + "%";
    li.append(name, wr); cp.append(li);
  }

  // matches
  list.innerHTML = "";
  const matches = res.matches || [];
  $("mh-more").classList.toggle("hidden", matches.length < matchCount);
  if (matches.length === 0) { list.classList.add("hidden"); $("mh-empty").classList.remove("hidden"); $("mh-empty").textContent = "No matches found for this filter."; return; }
  $("mh-empty").classList.add("hidden"); list.classList.remove("hidden");

  for (const m of matches) {
    const li = document.createElement("li");
    li.className = "match " + (m.remake ? "remake" : m.win ? "win" : "loss");

    const idCol = document.createElement("div"); idCol.className = "m-id";
    const champWrap = document.createElement("div"); champWrap.className = "m-champwrap";
    champWrap.append(mkImg(champImg(ver, m.champKey), "m-champ", function () { this.style.visibility = "hidden"; }));
    const lvl = document.createElement("span"); lvl.className = "m-lvl"; lvl.textContent = m.champLevel || "";
    champWrap.append(lvl);
    const spells = document.createElement("div"); spells.className = "m-spells";
    for (const sid of (m.spells || [])) { const sp = document.createElement("span"); sp.className = "m-spell"; const su = spellImg(ver, sid); if (su) sp.append(mkImg(su, "", function () { sp.classList.add("empty"); })); else sp.classList.add("empty"); spells.append(sp); }
    const runes = document.createElement("div"); runes.className = "m-runes";
    const kImg = currentRunes.perks && currentRunes.perks[m.keystone];
    const sImg = currentRunes.styles && currentRunes.styles[m.secondaryStyle];
    const rk = document.createElement("span"); rk.className = "m-rune key"; if (kImg) rk.append(mkImg(kImg, "", function () { rk.classList.add("empty"); })); else rk.classList.add("empty"); runes.append(rk);
    const rs = document.createElement("span"); rs.className = "m-rune"; if (sImg) rs.append(mkImg(sImg, "", function () { rs.classList.add("empty"); })); else rs.classList.add("empty"); runes.append(rs);
    idCol.append(champWrap, spells, runes);

    const main = document.createElement("div"); main.className = "m-main";
    main.innerHTML =
      `<div class="m-top"><span class="m-res">${m.remake ? "Remake" : m.win ? "Victory" : "Defeat"}</span>` +
      `<span class="m-q">${m.queue}</span></div>` +
      `<div class="m-bot"><span class="m-when">${timeAgo(m.endTs)} · ${dur(m.durationSec)}</span></div>`;

    const stats = document.createElement("div"); stats.className = "m-stats";
    stats.innerHTML =
      `<div class="m-kda"><b>${m.k} / <span class="d">${m.d}</span> / ${m.a}</b><span class="m-kdar">${m.kda} KDA</span></div>` +
      `<div class="m-cs">${m.cs} CS · ${m.csPerMin}/min</div>` +
      `<div class="m-extra">${typeof m.kp === "number" ? "P/Kill " + m.kp + "% · " : ""}${kFmt(m.dmg)} dmg</div>`;
    const badges = matchBadges(m);
    if (badges.length) {
      const bw = document.createElement("div"); bw.className = "m-badges";
      for (const b of badges) { const pill = document.createElement("span"); pill.className = "badge " + b.cls; pill.textContent = b.t; bw.append(pill); }
      stats.append(bw);
    }

    const items = document.createElement("div"); items.className = "m-items";
    for (const it of (m.items || [])) { const cell = document.createElement("span"); cell.className = "m-item"; if (it) cell.append(mkImg(itemImg(ver, it), "", function () { cell.classList.add("empty"); })); else cell.classList.add("empty"); items.append(cell); }

    const parts = document.createElement("div"); parts.className = "m-parts";
    const teams = { 100: document.createElement("div"), 200: document.createElement("div") };
    teams[100].className = teams[200].className = "m-team";
    for (const pp of (m.participants || [])) {
      const row = document.createElement("div"); row.className = "m-part" + (pp.me ? " me" : "");
      row.append(mkImg(champImg(ver, pp.champKey), "m-pico", function () { this.style.visibility = "hidden"; }));
      const nm = document.createElement("span"); nm.className = "m-pname"; nm.textContent = pp.name;
      row.append(nm);
      (teams[pp.teamId] || teams[100]).append(row);
    }
    parts.append(teams[100], teams[200]);

    // The expandable 10-player scoreboard needs the full lobby — LCU-sourced
    // rows only carry the player's own slot, so skip the caret entirely there.
    if (m.participants && m.participants.length) {
      const caret = document.createElement("button"); caret.className = "m-caret"; caret.textContent = "▾"; caret.title = "Match details";
      const detail = buildDetail(m, ver);
      const toggle = () => { const open = detail.classList.toggle("hidden"); caret.classList.toggle("open", !open); };
      caret.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
      li.addEventListener("click", toggle);
      li.append(idCol, main, stats, items, parts, caret, detail);
    } else {
      li.append(idCol, main, stats, items, parts);
    }
    list.append(li);
  }

  renderAnalytics(res, ver);
}

// ===== Friends =====
let friendsActive = false, friendsTimer = null, friendsTick = null, selectedFriend = null, friendsVer = null;
const profIcon = (ver, id) => `https://ddragon.leagueoflegends.com/cdn/${ver}/img/profileicon/${id}.png`;

function friendDuration(since) {
  if (!since) return "";
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const m = Math.floor(s / 60), ss = String(s % 60).padStart(2, "0");
  return `${m}:${ss}`;
}

function startFriends() {
  loadFriends();
  if (!friendsTimer) friendsTimer = setInterval(() => { if (friendsActive) loadFriends(); }, 5000);
  if (!friendsTick) friendsTick = setInterval(() => {
    if (!friendsActive) return;
    document.querySelectorAll(".fr-dur[data-since]").forEach((el) => { el.textContent = friendDuration(Number(el.dataset.since)); });
    const now = $("fr-d-now");
    if (now && now.dataset.since) now.textContent = friendDuration(Number(now.dataset.since));
  }, 1000);
}

const friendKey = (f) => f.key || f.puuid || f.name;
function avatarSrc(f) {
  if (f.champKey && friendsVer) return champImg(friendsVer, f.champKey);
  if (f.iconId && friendsVer) return profIcon(friendsVer, f.iconId);
  return null;
}
function friendAvatar(f, cls) {
  const src = avatarSrc(f);
  if (src) return mkImg(src, cls, function () { this.style.visibility = "hidden"; });
  const span = document.createElement("span"); span.className = cls + " fr-avatar-fallback"; span.textContent = (f.name || "?").slice(0, 1).toUpperCase();
  return span;
}
function friendSubText(f) {
  let subText = f.label;
  if (f.champName && (f.status === "ingame" || f.status === "champselect")) subText = (f.status === "champselect" ? "Hovering " : "Playing ") + f.champName;
  if (f.queue && f.status === "ingame") subText += " · " + f.queue;
  return subText;
}

// Friends search. Filters by name or champion; re-renders from the cached list
// without re-fetching (so it stays instant and doesn't touch the LCU each keystroke).
let friendQuery = "";
let allFriends = [];
function friendMatches(f) {
  if (!friendQuery) return true;
  return (f.name || "").toLowerCase().includes(friendQuery) || (f.champName || "").toLowerCase().includes(friendQuery);
}

// Keyed DOM reconciliation: each friend keeps its <li> (and its avatar <img>)
// across the 5s refresh, so we update text/status in place instead of tearing the
// list down. Rebuilding every poll is what made the profile pictures flash —
// brand-new <img> elements re-requested every cycle. Now the <img> is recreated
// ONLY when its source actually changes (champion swap / icon change).
const frNodes = new Map(); // key -> { li, avatarEl, avatarSrc, nameEl, subEl, sideEl, f }
function renderFriendList(friends) {
  const list = $("fr-list");
  const visible = friends.filter(friendMatches);
  const seen = new Set();
  for (const f of visible) {
    const key = friendKey(f);
    seen.add(key);
    let node = frNodes.get(key);
    if (!node) {
      const li = document.createElement("li");
      const avatarEl = friendAvatar(f, "fr-ico");
      const main = document.createElement("div"); main.className = "fr-main";
      const nameEl = document.createElement("div"); nameEl.className = "fr-name";
      const subEl = document.createElement("div"); subEl.className = "fr-sub";
      main.append(nameEl, subEl);
      const sideEl = document.createElement("div");
      li.append(avatarEl, main, sideEl);
      node = { li, avatarEl, avatarSrc: avatarSrc(f), nameEl, subEl, sideEl, f };
      li.addEventListener("click", () => selectFriend(node.f));
      frNodes.set(key, node);
    }
    node.f = f;
    node.li.className = "fr-item ring-" + f.status + (key === selectedFriend ? " active" : "");
    node.li.dataset.key = key;
    node.li.dataset.puuid = f.puuid || "";
    // Swap the avatar element ONLY when its source changed — this is what stops the flashing.
    const src = avatarSrc(f);
    if (src !== node.avatarSrc) {
      node.avatarSrc = src;
      const fresh = friendAvatar(f, "fr-ico");
      node.li.replaceChild(fresh, node.avatarEl);
      node.avatarEl = fresh;
    }
    node.nameEl.textContent = f.name;
    node.subEl.textContent = friendSubText(f);
    if (f.status === "ingame" && f.since) { node.sideEl.className = "fr-dur"; node.sideEl.dataset.since = String(f.since); node.sideEl.textContent = friendDuration(f.since); }
    else if (f.justFinished) { node.sideEl.className = "fr-fin"; delete node.sideEl.dataset.since; node.sideEl.textContent = "Just finished"; }
    else { node.sideEl.className = ""; delete node.sideEl.dataset.since; node.sideEl.textContent = ""; }
    list.append(node.li); // re-append keeps sorted order without recreating the <img>
  }
  for (const [key, node] of frNodes) { if (!seen.has(key)) { node.li.remove(); frNodes.delete(key); } }
  const noRes = $("fr-noresults");
  if (noRes) noRes.classList.toggle("hidden", !(friends.length && !visible.length));
}

async function loadFriends() {
  if (!api.getFriends) return;
  let res; try { res = await api.getFriends(); } catch (_) { res = null; }
  const offline = $("fr-offline"), list = $("fr-list"), count = $("fr-count"), noRes = $("fr-noresults");
  const clearList = () => {
    for (const [, n] of frNodes) n.li.remove();
    frNodes.clear(); allFriends = [];
    // Drop any open profile — the friend it referenced is gone from the list.
    selectedFriend = null;
    const panel = $("fr-panel"), empty = $("fr-empty");
    if (panel) panel.classList.add("hidden");
    if (empty) empty.classList.remove("hidden");
  };
  if (!res || !res.ok) {
    clearList();
    offline.classList.remove("hidden");
    offline.textContent = res && res.error === "client"
      ? "Open the League client to see your friends."
      : "Couldn't reach your friends list — is the League client running?";
    list.classList.add("hidden"); if (noRes) noRes.classList.add("hidden"); count.textContent = "";
    return;
  }
  friendsVer = res.version || friendsVer;
  const friends = res.friends || [];
  if (!friends.length) {
    clearList();
    offline.classList.remove("hidden"); offline.textContent = "No friends found on your League account.";
    list.classList.add("hidden"); if (noRes) noRes.classList.add("hidden"); count.textContent = "";
    return;
  }
  allFriends = friends;
  offline.classList.add("hidden"); list.classList.remove("hidden");
  const online = friends.filter((f) => f.status !== "offline");
  count.textContent = online.length ? `${online.length} online` : "";
  renderFriendList(friends);
}

// Rank medal + LP. Tier drives the medal color class + label.
const TIER_NAME = { IRON: "Iron", BRONZE: "Bronze", SILVER: "Silver", GOLD: "Gold", PLATINUM: "Platinum", EMERALD: "Emerald", DIAMOND: "Diamond", MASTER: "Master", GRANDMASTER: "Grandmaster", CHALLENGER: "Challenger" };
const TIER_CLASS = { IRON: "iron", BRONZE: "bronze", SILVER: "silver", GOLD: "gold", PLATINUM: "plat", EMERALD: "emerald", DIAMOND: "diamond", MASTER: "master", GRANDMASTER: "gm", CHALLENGER: "chall" };
const APEX = { MASTER: 1, GRANDMASTER: 1, CHALLENGER: 1 };
const fmtMastery = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));

function renderRank(rank) {
  const medal = $("fr-medal"), tierEl = $("fr-rank-tier"), lpText = $("fr-lp-text"), lpNext = $("fr-lp-next"), lpFill = $("fr-lp-fill");
  medal.setAttribute("class", "fr-medal"); // SVG: className is read-only, use setAttribute
  if (!rank || !rank.tier) {
    medal.classList.add("tier-unranked");
    tierEl.textContent = "Unranked"; lpText.textContent = "—"; lpNext.textContent = ""; lpFill.style.width = "0%";
    return;
  }
  const t = String(rank.tier).toUpperCase();
  medal.classList.add("tier-" + (TIER_CLASS[t] || "unranked"));
  tierEl.textContent = (TIER_NAME[t] || rank.tier) + (APEX[t] ? "" : (rank.division ? " " + rank.division : ""));
  const lp = rank.lp != null ? rank.lp : 0;
  lpText.textContent = lp + " LP";
  const pct = Math.max(0, Math.min(100, lp));
  lpFill.style.width = pct + "%";
  lpNext.textContent = APEX[t] ? "" : (100 - pct) + " to promo";
}

function renderProfile(profile) {
  renderRank(profile && profile.rank);
  $("fr-wr").textContent = profile && profile.winRate != null ? profile.winRate + "%" : "—";
  $("fr-matches").textContent = profile && profile.matches ? String(profile.matches) : "—";
  $("fr-kda").textContent = profile && profile.kda != null ? Number(profile.kda).toFixed(2) : "—";

  const wrap = $("fr-mastery"), empty = $("fr-mastery-empty");
  const list = (profile && profile.mastery) || [];
  wrap.innerHTML = "";
  if (!list.length) { wrap.classList.add("hidden"); empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden"); wrap.classList.remove("hidden");
  for (const m of list) {
    const cell = document.createElement("div"); cell.className = "fr-champ";
    const port = document.createElement("div"); port.className = "fr-champ-port";
    if (m.icon) port.append(mkImg(m.icon, "fr-champ-img", function () { this.style.visibility = "hidden"; }));
    else port.textContent = (m.name || "?").slice(0, 1);
    const lvl = document.createElement("span"); lvl.className = "fr-champ-m"; lvl.textContent = "M" + (m.level || 0);
    port.append(lvl);
    const nm = document.createElement("div"); nm.className = "fr-champ-name"; nm.textContent = m.name;
    const pts = document.createElement("div"); pts.className = "fr-champ-pts"; pts.textContent = fmtMastery(m.points || 0);
    cell.append(port, nm, pts);
    wrap.append(cell);
  }
}

// ---- Live spectate (draft only) ----
let spectateFor = null;
function resetSpectate() {
  spectateFor = null;
  ["fr-spec", "fr-spec-loading", "fr-spec-none", "fr-spec-body"].forEach((id) => { const e = $(id); if (e) e.classList.add("hidden"); });
}

function renderSpecTeam(container, players) {
  container.innerHTML = "";
  for (const p of players) {
    const row = document.createElement("div"); row.className = "fr-pl" + (p.isFriend ? " is-friend" : "");
    const champ = document.createElement("div"); champ.className = "fr-pl-champ";
    if (p.championIcon) champ.append(mkImg(p.championIcon, "fr-pl-img", function () { this.style.visibility = "hidden"; }));
    else champ.textContent = (p.champion || "?").slice(0, 1);
    const spells = document.createElement("div"); spells.className = "fr-pl-spells";
    for (const s of p.spells || []) {
      if (s) spells.append(mkImg(s, "fr-pl-spell", function () { this.style.visibility = "hidden"; }));
      else { const ph = document.createElement("span"); ph.className = "fr-pl-spell"; spells.append(ph); }
    }
    const name = document.createElement("div"); name.className = "fr-pl-name"; name.textContent = p.name || p.champion || "";
    row.append(champ, spells, name);
    container.append(row);
  }
}

async function loadSpectate(puuid) {
  spectateFor = puuid;
  $("fr-spec").classList.remove("hidden");
  $("fr-spec-loading").classList.remove("hidden"); $("fr-spec-none").classList.add("hidden"); $("fr-spec-body").classList.add("hidden");
  let res; try { res = await api.getFriendLive(puuid); } catch (_) { res = null; }
  if (spectateFor !== puuid) return; // friend changed / panel collapsed
  $("fr-spec-loading").classList.add("hidden");
  if (!res || !res.ok || !res.inGame) {
    $("fr-spec-none").classList.remove("hidden");
    $("fr-spec-none").textContent = res && res.ok && !res.inGame ? "Not in a game right now." : "Live game data unavailable (needs a linked Riot key).";
    return;
  }
  $("fr-spec-body").classList.remove("hidden");
  const mm = Math.floor((res.gameLength || 0) / 60), ss = String((res.gameLength || 0) % 60).padStart(2, "0");
  $("fr-spec-meta").textContent = `${res.queue || "Live game"} · ${mm}:${ss}`;
  renderSpecTeam($("fr-blue"), res.blue || []);
  renderSpecTeam($("fr-red"), res.red || []);
}

// Wire the friends search box (filters the cached list, no refetch).
(function wireFriendSearch() {
  const inp = $("fr-search");
  if (!inp) return;
  inp.addEventListener("input", () => {
    friendQuery = inp.value.trim().toLowerCase();
    if (allFriends.length) renderFriendList(allFriends);
  });
})();

async function selectFriend(f) {
  const key = friendKey(f);
  selectedFriend = key;
  document.querySelectorAll(".fr-item").forEach((el) => el.classList.toggle("active", el.dataset.key === key));
  $("fr-empty").classList.add("hidden"); $("fr-panel").classList.remove("hidden");

  const icon = $("fr-d-icon");
  if (f.champKey && friendsVer) { icon.src = champImg(friendsVer, f.champKey); icon.style.visibility = "visible"; }
  else if (f.iconId && friendsVer) { icon.src = profIcon(friendsVer, f.iconId); icon.style.visibility = "visible"; }
  else icon.style.visibility = "hidden";
  $("fr-d-name").textContent = f.name + (f.tag ? " #" + f.tag : "");
  $("fr-d-status").textContent = f.champName ? `${f.label} · ${f.champName}${f.queue ? " · " + f.queue : ""}` : f.label;
  const now = $("fr-d-now");
  if (f.status === "ingame" && f.since) { now.dataset.since = String(f.since); now.textContent = friendDuration(f.since); }
  else { delete now.dataset.since; now.textContent = ""; }

  // Watch Live only when the friend is actually in a game.
  const inGame = f.status === "ingame";
  const watch = $("fr-watch");
  watch.classList.toggle("hidden", !inGame);
  watch.onclick = inGame ? () => loadSpectate(f.puuid) : null;
  resetSpectate();

  renderProfile(null); // placeholders while the detail loads

  const tl = $("fr-d-tl"), tlEmpty = $("fr-d-tl-empty"), loading = $("fr-d-loading"), matchLbl = $("fr-d-match");
  tl.classList.add("hidden"); tlEmpty.classList.add("hidden"); loading.classList.remove("hidden"); matchLbl.textContent = "—";

  // Rank / recent form / mastery + the live game all come from the official Riot
  // API, which needs a linked key. Without one (or without a puuid) show a clear
  // prompt instead of spinning forever.
  const needKey = !f.puuid || !(lastSettings && lastSettings.hasRiotKey);
  if (needKey) {
    loading.classList.add("hidden");
    tlEmpty.classList.remove("hidden");
    tlEmpty.textContent = !(lastSettings && lastSettings.hasRiotKey)
      ? "Link a Riot API key in Settings to see ranks, recent form and live games."
      : "Profile unavailable for this friend.";
    matchLbl.textContent = "—";
    return;
  }

  let res; try { res = await api.getFriendDetail(f.puuid); } catch (_) { res = null; }
  if (selectedFriend !== key) return; // a newer selection won the race
  loading.classList.add("hidden");

  if (res && res.profile) renderProfile(res.profile);

  const d = res && res.digest;
  if (!d || !d.entries || !d.entries.length) {
    tlEmpty.classList.remove("hidden");
    tlEmpty.textContent = "No notable events from the last game.";
    matchLbl.textContent = d && d.matchId ? "Match " + d.matchId : "No recent match";
  } else {
    matchLbl.textContent = "Match " + (d.matchId || "");
    tl.classList.remove("hidden"); tl.innerHTML = "";
    const ICON = { "fb-you": "🩸", fb: "🩸", kill: "⚔️", obj: "🐉", skill: "🔮" };
    for (const e of d.entries) {
      const row = document.createElement("li"); row.className = "fr-tl-row";
      // textContent, not innerHTML — entry text is engine-built today, but keep
      // remote-derived strings out of HTML on principle.
      const t = document.createElement("span"); t.className = "fr-tl-t"; t.textContent = e.time;
      const i = document.createElement("span"); i.className = "fr-tl-i"; i.textContent = ICON[e.kind] || "•";
      const x = document.createElement("span"); x.className = "fr-tl-x"; x.textContent = e.text;
      row.append(t, i, x);
      tl.append(row);
    }
  }
}

// ===== TFT =====
let tftLoaded = false;
const PLACE_SUFFIX = { 1: "st", 2: "nd", 3: "rd" };
const ordinal = (n) => n + (PLACE_SUFFIX[n] || "th");

// TFT round -> "stage-round" label (stage 1 = 4 rounds, stages 2+ = 7 each).
function tftStage(r) {
  if (!r || r < 1) return "";
  if (r <= 4) return "1-" + r;
  return (2 + Math.floor((r - 5) / 7)) + "-" + (((r - 5) % 7) + 1);
}

const TFT_TIER_LETTER = { IRON: "I", BRONZE: "B", SILVER: "S", GOLD: "G", PLATINUM: "P", EMERALD: "E", DIAMOND: "D", MASTER: "M", GRANDMASTER: "GM", CHALLENGER: "C" };
const cap1 = (t) => (t ? t[0] + t.slice(1).toLowerCase() : "");

function renderTftRank(rank) {
  const tierEl = $("tftr-tier"), lpEl = $("tftr-lp"), wlEl = $("tftr-wl"), em = $("tftr-emblem"), ring = $("tftr-ring");
  if (rank && rank.ranked) {
    tierEl.textContent = cap1(rank.tier) + (rank.division ? " " + rank.division : "");
    lpEl.textContent = rank.lp + " LP";
    const g = rank.wins + rank.losses;
    wlEl.innerHTML = `<b>${rank.wins}</b> top-4 · <b>${rank.losses}</b> bot-4` + (g ? ` · <b>${Math.round((rank.wins / g) * 100)}%</b>` : "");
    em.textContent = TFT_TIER_LETTER[rank.tier] || "?";
    if (ring) ring.style.setProperty("--lp-pct", String(Math.max(0, Math.min(100, rank.lp))));
  } else {
    tierEl.textContent = "Unranked";
    lpEl.textContent = "—";
    wlEl.textContent = rank && rank.error === "tft-access" ? "Enable the TFT APIs on your key to see rank." : "Play ranked TFT to start tracking";
    em.textContent = "?";
    if (ring) ring.style.setProperty("--lp-pct", "0");
  }
}

function renderTftAnalytics(analytics) {
  const dist = (analytics && analytics.distribution) || {};
  $("tftk-top4").textContent = dist.total ? dist.top4Rate + "%" : "—";
  $("tftk-avg").textContent = dist.total ? dist.avgPlacement.toFixed ? dist.avgPlacement.toFixed(2) : dist.avgPlacement : "—";
  $("tftk-games").textContent = dist.total || "—";
  $("tfth-record").textContent = dist.total ? `${dist.top4Rate}% top-4 · ${dist.avgPlacement} avg` : "—";
  $("tfth-wins").textContent = dist.total ? Math.round((dist.winRate / 100) * dist.total) : "—";
  const comps = (analytics && analytics.comps) || [];
  $("tfth-best").textContent = comps.length ? comps.slice().sort((a, b) => a.avgPlacement - b.avgPlacement)[0].archetype : "—";

  const ul = $("tft-mycomps"), cEmpty = $("tft-mycomps-empty");
  ul.innerHTML = "";
  if (!comps.length) { cEmpty.classList.remove("hidden"); return; }
  cEmpty.classList.add("hidden");
  for (const c of comps.slice(0, 5)) {
    const li = document.createElement("li"); li.className = "mycomp-row";
    const name = document.createElement("span"); name.className = "mycomp-name"; name.textContent = c.archetype;
    const games = document.createElement("span"); games.className = "mycomp-sub"; games.textContent = c.games + " games";
    const right = document.createElement("span"); right.className = "mycomp-right " + (c.top4Rate >= 50 ? "pos" : "neg");
    right.textContent = `${c.top4Rate}% · ${c.avgPlacement} avg`;
    li.append(name, games, right);
    ul.append(li);
  }
}

// Curated, set-agnostic strategy lines — hand-written knowledge like the draft
// coach. Deliberately NOT set-specific trait comps and NOT live stats: Riot has
// no comps API and scraping stat sites is off-limits, so this stays editorial.
const TFT_PLAYBOOK = [
  { name: "Standard Tempo", kind: "FLEX", plan: "Level on curve (6 at 3-2, 7 at 4-1, 8 at 5-1) and always play your strongest board." },
  { name: "Fast 8", kind: "TEMPO", plan: "Greed econ to 50 by 3-2, push level 8 at 4-2/4-5, then roll for 4-cost carries." },
  { name: "3-Cost Reroll", kind: "REROLL", plan: "Level 6 at 3-2 and slow-roll above 50 gold for your three-star 3-cost carry." },
  { name: "1-Cost Slow Roll", kind: "REROLL", plan: "Hold level 4 and roll above 50 gold from stage 3 for three-star 1-costs." },
  { name: "Hyper Roll", kind: "ALL-IN", plan: "Preserve gold breakpoints, then roll to zero at 3-1 — stabilize hard or accept the top-6 exit." },
];
function renderTftPlaybook() {
  const ul = $("tft-playbook");
  if (!ul || ul.childElementCount) return;
  for (const p of TFT_PLAYBOOK) {
    const li = document.createElement("li"); li.className = "pb-row";
    const head = document.createElement("div"); head.className = "pb-head";
    const nm = document.createElement("span"); nm.className = "pb-name"; nm.textContent = p.name;
    const kind = document.createElement("span"); kind.className = "pb-kind"; kind.textContent = p.kind;
    head.append(nm, kind);
    const plan = document.createElement("div"); plan.className = "pb-plan"; plan.textContent = p.plan;
    li.append(head, plan);
    ul.append(li);
  }
}

// Static item-recipe explorer (CommunityDragon static table; chips filter it).
let tftRecipeData = null, tftRecipeFilter = "";
function renderTftRecipes(data) {
  if (data) tftRecipeData = data;
  const card = $("tft-recipes-card"), chips = $("tft-comp-chips"), grid = $("tft-recipe-grid");
  if (!tftRecipeData || !Array.isArray(tftRecipeData.recipes) || !tftRecipeData.recipes.length) return;
  card.classList.remove("hidden");
  const visible = tftRecipeFilter
    ? tftRecipeData.recipes.filter((r) => r.parts.includes(tftRecipeFilter))
    : tftRecipeData.recipes;
  $("tft-recipes-count").textContent = visible.length + " combines";
  chips.innerHTML = "";
  for (const c of tftRecipeData.components) {
    const b = document.createElement("button");
    b.className = "chip" + (tftRecipeFilter === c ? " on" : "");
    b.textContent = c;
    b.addEventListener("click", () => { tftRecipeFilter = tftRecipeFilter === c ? "" : c; renderTftRecipes(); });
    chips.append(b);
  }
  grid.innerHTML = "";
  for (const r of visible) {
    const cell = document.createElement("div"); cell.className = "recipe-cell";
    const nm = document.createElement("div"); nm.className = "recipe-item"; nm.textContent = r.name;
    const parts = document.createElement("div"); parts.className = "recipe-parts"; parts.textContent = r.parts.join(" + ");
    cell.append(nm, parts);
    grid.append(cell);
  }
}

async function loadTft() {
  if (!api.getTftMatches) return;
  const loading = $("tft-loading"), access = $("tft-access"), empty = $("tft-empty"), grid = $("tft-grid"), list = $("tft-list");
  loading.classList.remove("hidden"); access.classList.add("hidden"); empty.classList.add("hidden"); grid.classList.add("hidden");
  renderTftPlaybook();
  // Rank + recipes load independently of history (each fails soft).
  if (api.getTftRank) api.getTftRank().then(renderTftRank).catch(() => renderTftRank(null));
  if (api.getTftRecipes) api.getTftRecipes().then((d) => { if (d && !d.error) renderTftRecipes(d); }).catch(() => {});
  let res; try { res = await api.getTftAnalytics(20); } catch (_) { res = null; }
  loading.classList.add("hidden");
  if (!res || !res.ok) {
    if (res && res.error === "tft-access") { access.classList.remove("hidden"); }
    else { empty.classList.remove("hidden"); $("tft-empty").textContent = (res && res.error === "link") ? "Open the League client (or link a Riot key in Settings) to load TFT history." : (res && res.error) || "Couldn't load TFT matches."; }
    return;
  }
  tftLoaded = true;
  const matches = res.matches || [];
  if (!matches.length) { empty.classList.remove("hidden"); $("tft-empty").textContent = "No recent TFT matches found."; return; }
  grid.classList.remove("hidden");
  renderTftAnalytics(res.analytics);
  list.innerHTML = "";
  for (const m of matches) list.append(renderTftCard(m));
}

function renderTftCard(m) {
  const li = document.createElement("li");
  const tier = m.placement === 1 ? "first" : m.placement <= 4 ? "top" : "bot";
  li.className = "tft-card " + tier;

  const head = document.createElement("div"); head.className = "tft-head";
  head.innerHTML =
    `<span class="tft-place ${tier}">${m.placement ? ordinal(m.placement) : "—"}</span>` +
    `<div class="tft-meta"><div class="tft-q">${m.queue}${m.set ? " · Set " + m.set : ""}</div>` +
    `<div class="tft-sub">Lvl ${m.level}${m.lastRound ? " · out " + tftStage(m.lastRound) : ""} · ${Math.floor(m.length / 60)}m · ${timeAgo(m.endTs)}</div></div>`;
  li.append(head);

  if (m.traits && m.traits.length) {
    const tr = document.createElement("div"); tr.className = "tft-traits";
    for (const t of m.traits.slice(0, 6)) {
      const pill = document.createElement("span"); pill.className = "tft-trait style-" + (t.style || 1);
      pill.textContent = `${t.units} ${t.name}`;
      tr.append(pill);
    }
    li.append(tr);
  }

  if (m.units && m.units.length) {
    const board = document.createElement("div"); board.className = "tft-board";
    for (const u of m.units) {
      const tile = document.createElement("div"); tile.className = "tft-unit cost-" + Math.min(5, Math.max(1, u.cost));
      const stars = document.createElement("div"); stars.className = "tft-stars s" + u.star; stars.textContent = "★".repeat(u.star);
      const nm = document.createElement("div"); nm.className = "tft-uname"; nm.textContent = u.name;
      tile.append(stars, nm);
      if (u.items && u.items.length) { const it = document.createElement("div"); it.className = "tft-uitems"; it.textContent = "● ".repeat(u.items.length).trim(); it.title = u.items.join(", "); tile.append(it); }
      board.append(tile);
    }
    li.append(board);
  }
  return li;
}

// ===== Data loop =====
async function refresh() { try { render(await api.getHome()); } catch (_) {} }

// ===== AI prediction =====
$("predict-btn").addEventListener("click", async () => {
  const btn = $("predict-btn"), out = $("predict-out");
  btn.disabled = true; out.classList.remove("hidden"); out.classList.add("loading"); out.textContent = "Analyzing your climb…";
  try {
    const res = await api.predictRankUp();
    renderAiOut(out, res, "Couldn't generate advice.");
  } catch (e) { out.classList.remove("loading"); out.textContent = "Advice failed: " + (e && e.message ? e.message : "error"); }
  finally { btn.disabled = false; }
});

// ===== AI champion picks =====
$("champ-btn").addEventListener("click", async () => {
  const btn = $("champ-btn"), out = $("champ-out");
  btn.disabled = true; out.classList.remove("hidden"); out.classList.add("loading"); out.textContent = "Finding your best champions to climb…";
  try {
    const res = await api.suggestChamps();
    renderAiOut(out, res, "Couldn't generate suggestions.");
  } catch (e) { out.classList.remove("loading"); out.textContent = "Suggestion failed: " + (e && e.message ? e.message : "error"); }
  finally { btn.disabled = false; }
});

// AI features are gated purely on a valid Claude key being present. body.no-ai
// hides every AI surface (dashboard cards) until the user adds one in Settings.
function applyAiGate(hasKey) {
  document.body.classList.toggle("no-ai", !hasKey);
}
const aiLockedBtn = $("ai-locked-btn");
if (aiLockedBtn) aiLockedBtn.addEventListener("click", () => {
  const target = document.querySelector('.nav-item[data-page="settings"]');
  if (target) target.click();
  const k = $("set-key"); if (k) k.focus();
});

// ===== Settings: AI save + re-link =====
let settingsDirty = false;
let claudeMode = false; // legacy flag; AI is now key-gated. Kept true when a key exists.
function setClaudeMode(on) { claudeMode = !!on; }
$("set-key").addEventListener("input", () => (settingsDirty = true));
$("set-baseline").addEventListener("input", () => (settingsDirty = true));

// General: overlay-design default + default match count (mark dirty; saved with Save)
let ovDesignMode = false;
$("seg-ovdesign").querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => { ovDesignMode = b.dataset.v === "on"; setSeg("seg-ovdesign", b.dataset.v); settingsDirty = true; })
);
$("set-mhcount").addEventListener("change", () => (settingsDirty = true));

$("set-save").addEventListener("click", async () => {
  const st = $("set-status");
  try {
    const aiKey = $("set-key").value.trim();
    await api.saveSettings({
      anthropicApiKey: aiKey,
      baselineApiUrl: $("set-baseline").value.trim(),
      coachUseClaude: !!aiKey, // AI is on whenever a valid key is present
      overlayDefaultDesign: ovDesignMode,
      matchCount: parseInt($("set-mhcount").value, 10) || 20,
    });
    settingsDirty = false; st.textContent = aiKey ? "Saved — AI features enabled" : "Saved"; st.classList.add("show"); setTimeout(() => st.classList.remove("show"), 2200);
    // Reflect the new gate immediately without waiting for the 5s refresh.
    applyAiGate(!!aiKey);
  } catch (_) { st.textContent = "Save failed"; st.classList.add("show"); }
});
$("set-relink").addEventListener("click", () => {
  if (lastSettings) { $("su-riotid").value = lastSettings.riotId || ""; }
  loadRegions().then(() => { if (lastSettings && lastSettings.region) $("su-region").value = lastSettings.region; });
  showSetup(true);
});
$("lm-review").addEventListener("click", () => api.openReview && api.openReview());

// General: launch-on-startup toggle (applied immediately via the OS)
$("seg-startup").querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", async () => {
    const on = b.dataset.v === "on";
    setSeg("seg-startup", b.dataset.v);
    try { if (api.setStartup) await api.setStartup(on); } catch (_) {}
  })
);

// Data & About
(async () => {
  if (!api.getAppInfo) return;
  try {
    const info = await api.getAppInfo();
    if (info) {
      const v = $("set-version"); if (v) v.textContent = "PepStats v" + (info.version || "?");
      setSeg("seg-startup", info.startup ? "on" : "off");
    }
  } catch (_) {}
})();
const dataStatus = (msg) => { const el = $("set-data-status"); if (!el) return; el.textContent = msg; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 1800); };
$("set-clearcache").addEventListener("click", async () => {
  try {
    const r = api.clearMatchCache && await api.clearMatchCache();
    // Edge case C: purge the local render caches and force an immediate redraw
    // instead of waiting for the 5s interval loop, so the user never stares at
    // stale/ghost data after clearing.
    dashLoaded = false; dashLastTry = 0; lastMatches = []; matchesLoaded = false;
    await refresh();                 // re-pull home snapshot + redraw graphs
    await loadDashboardExtras(true);  // force-refetch recent matches / champ pool
    if (!$("page-progress").classList.contains("hidden")) loadMatches();
    dataStatus(r && r.ok ? "Cache cleared" : "Couldn't clear cache");
  } catch (_) { dataStatus("Couldn't clear cache"); }
});
$("set-openfolder").addEventListener("click", () => { try { api.openDataFolder && api.openDataFolder(); } catch (_) {} });
$("set-github").addEventListener("click", () => { try { api.openRepo && api.openRepo(); } catch (_) {} });

// ===== Appearance (live theming) =====
const ACCENTS = ["#ff004c", "#00bfff", "#4f9dff", "#a06bff", "#ff5d9e", "#46c98a", "#d9b35e"];
const ROWS = [["csm", "CSM"], ["gpm", "GPM"], ["vision", "VIS"], ["kp", "KP%"], ["kda", "KDA"], ["lvl", "LVL"]];

// Build swatches + row chips once
(function buildAppearance() {
  const sw = $("swatches");
  ACCENTS.forEach((c) => { const b = document.createElement("button"); b.className = "sw"; b.style.background = c; b.dataset.c = c; b.addEventListener("click", () => saveTheme({ accent: c })); sw.append(b); });
  const rt = $("row-toggles");
  ROWS.forEach(([key, lbl]) => { const b = document.createElement("button"); b.className = "chip"; b.textContent = lbl; b.dataset.row = key; b.addEventListener("click", () => { const cur = currentTheme(); const rows = { ...(cur.overlay.rows || {}) }; rows[key] = !rows[key]; saveTheme({ overlay: { rows } }); }); rt.append(b); });
})();

// Custom accent picker. The native <input type="color"> fires `input` rapidly
// while dragging; firing an async saveTheme on every event meant the IPC response
// wrote the value back INTO the open picker mid-drag, which made it jump/glitch.
// Fix: debounce the persist, and (in syncAppearance) never write the value back
// while the picker is the active element.
let _accentTimer = null;
$("accent-custom").addEventListener("input", (e) => {
  const v = e.target.value;
  clearTimeout(_accentTimer);
  _accentTimer = setTimeout(() => saveTheme({ accent: v }), 140);
});
$("accent-custom").addEventListener("change", (e) => { clearTimeout(_accentTimer); saveTheme({ accent: e.target.value }); });
$("seg-theme").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => saveTheme({ theme: b.dataset.v })));
$("seg-champsync").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => saveTheme({ championSync: b.dataset.v === "on" })));
$("seg-density").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => saveTheme({ density: b.dataset.v })));
$("rng-font").addEventListener("input", (e) => saveTheme({ fontScale: parseFloat(e.target.value) }));
$("rng-ovscale").addEventListener("input", (e) => saveTheme({ overlay: { scale: parseFloat(e.target.value) } }));
$("rng-ovop").addEventListener("input", (e) => saveTheme({ overlay: { opacity: parseFloat(e.target.value) } }));

let _theme = null;
const currentTheme = () => _theme || { theme: "dark", accent: "#ff004c", density: "comfortable", fontScale: 1, overlay: { scale: 1, opacity: 1, rows: {} } };
async function saveTheme(patch) { try { _theme = await api.saveTheme(patch); syncAppearance(_theme); } catch (_) {} }

function syncAppearance(t) {
  if (!t) return; _theme = t;
  $("seg-theme").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === t.theme));
  const csOn = t.championSync !== false;
  $("seg-champsync").querySelectorAll("button").forEach((b) => b.classList.toggle("active", (b.dataset.v === "on") === csOn));
  // The home window has no champion context, so it always shows the default
  // Hextech-blue dynamic accent; the live tint applies in pre-game / overlay.
  if (window.syncAppTheme) window.syncAppTheme("", false);
  $("seg-density").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === t.density));
  document.querySelectorAll("#swatches .sw").forEach((s) => s.classList.toggle("active", s.dataset.c.toLowerCase() === (t.accent || "").toLowerCase()));
  // Don't overwrite the picker's value while the user is actively picking — that
  // writeback is what made it glitch.
  const ac = $("accent-custom");
  if (document.activeElement !== ac) ac.value = /^#[0-9a-fA-F]{6}$/.test(t.accent) ? t.accent : "#ff004c";
  $("rng-font").value = t.fontScale; $("val-font").textContent = Math.round(t.fontScale * 100) + "%";
  $("rng-ovscale").value = t.overlay.scale; $("val-ovscale").textContent = Math.round(t.overlay.scale * 100) + "%";
  $("rng-ovop").value = t.overlay.opacity; $("val-ovop").textContent = Math.round(t.overlay.opacity * 100) + "%";
  document.querySelectorAll("#row-toggles .chip").forEach((c) => c.classList.toggle("on", !!(t.overlay.rows || {})[c.dataset.row]));
}

// ===== Boot =====
if (api.getTheme) api.getTheme().then(syncAppearance).catch(() => {});
if (api.onHome) api.onHome(() => refresh());
refresh();
setInterval(refresh, 5000);
