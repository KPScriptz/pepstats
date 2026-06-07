"use strict";

const $ = (id) => document.getElementById(id);
const api = window.pepstats || {};

// ---- Window controls (setup + app) ----
for (const id of ["su-min", "tb-min"]) { const el = $(id); if (el) el.addEventListener("click", () => api.winMin && api.winMin()); }
for (const id of ["su-close", "tb-close"]) { const el = $(id); if (el) el.addEventListener("click", () => api.winClose && api.winClose()); }

// ---- Navigation ----
const PAGE_META = {
  dashboard: ["Dashboard", "Your ranked snapshot"],
  progress: ["Progress", "Climb history & trends"],
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
  });
});

// ---- Helpers ----
const PHASE_LABEL = {
  None: "Idle", Lobby: "In lobby", Matchmaking: "In queue", ReadyCheck: "Ready check",
  ChampSelect: "Champ select", InProgress: "In game", WaitingForStats: "Loading results",
  PreEndOfGame: "Post-game", EndOfGame: "Post-game",
};
const signedLp = (n) => (n == null ? "—" : (n >= 0 ? "+" : "−") + Math.abs(n));

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
function showSetup(show) {
  $("setup").classList.toggle("hidden", !show);
  $("app").classList.toggle("hidden", show);
  if (show) loadRegions();
}
$("su-connect").addEventListener("click", async () => {
  const btn = $("su-connect"), err = $("su-error");
  err.classList.add("hidden"); btn.disabled = true; const prev = btn.textContent; btn.textContent = "Connecting…";
  try {
    const res = await api.connectRiot({ riotId: $("su-riotid").value, region: $("su-region").value, riotApiKey: $("su-key").value });
    if (res && res.ok) { showSetup(false); refresh(); }
    else { err.textContent = (res && res.error) || "Couldn't connect. Check your details."; err.classList.remove("hidden"); }
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

  const p = (summary && summary.progress) || {};
  const solo = summary && summary.solo;
  const sm = summary && summary.summoner;

  // Rank chip (rail)
  $("rc-em").textContent = solo && solo.tier ? solo.tier[0] : "?";
  $("rc-tx").textContent = p.label || "Unranked";

  // Hero
  $("rank-now").textContent = p.label || "Unranked";
  $("emblem-letter").textContent = solo && solo.tier ? solo.tier[0] : "?";
  $("rank-next").textContent = p.next ? "Next: " + p.next : "Play ranked to start tracking";
  const div = p.division || { pct: 0, lp: 0, toNext: 100 };
  $("lp-fill").style.width = (solo ? div.pct : 0) + "%";
  $("lp-text").textContent = solo ? `${div.lp} LP · ${div.toNext} to ${p.next || "promo"}` : "Unranked";

  // KPIs
  const wk = (summary && summary.weekly) || {};
  const wkEl = $("kpi-weekly");
  if (wk.tracking || wk.gain == null) { wkEl.textContent = "tracking…"; wkEl.className = "kpi-val"; wkEl.style.fontSize = "13px"; }
  else { wkEl.textContent = signedLp(wk.gain) + " LP"; wkEl.className = "kpi-val " + (wk.gain > 0 ? "pos" : wk.gain < 0 ? "neg" : ""); wkEl.style.fontSize = ""; }
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
  progressSummary = { solo, p };
  $("rs-em").textContent = solo && solo.tier ? solo.tier[0] : "?";
  $("rs-tier").textContent = p.label || "Unranked";
  $("rs-lp").textContent = solo ? `${div.lp} LP` : "—";
  $("rs-wr").textContent = solo ? `${p.winRate != null ? p.winRate + "% WR" : "—"} · ${p.wins}W ${p.losses}L` : "—";

  // Settings: account + AI fields
  $("set-riotid").textContent = (settings && settings.riotId) || "Not linked";
  $("set-region").textContent = (settings && settings.region) || "—";
  if (!settingsDirty) {
    if (document.activeElement !== $("set-key")) $("set-key").value = (settings && settings.anthropicApiKey) || "";
    if (document.activeElement !== $("set-baseline")) $("set-baseline").value = (settings && settings.baselineApiUrl) || "";
  }
}

// ===== Match history (Progress page, op.gg-style) =====
let progressSummary = null;
let matchFilter = "all";
let matchesLoaded = false;
let filtersBuilt = false;

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

async function buildFilters() {
  if (filtersBuilt || !api.getMatchFilters) return;
  try {
    const fs = await api.getMatchFilters();
    const sel = $("mh-filter"); sel.innerHTML = "";
    for (const f of fs || []) { const o = document.createElement("option"); o.value = f.key; o.textContent = f.label; sel.append(o); }
    sel.value = matchFilter;
    sel.addEventListener("change", () => { matchFilter = sel.value; loadMatches(); });
    filtersBuilt = true;
  } catch (_) {}
}

async function loadMatches() {
  await buildFilters();
  const loading = $("mh-loading"), empty = $("mh-empty"), list = $("mh-list");
  loading.classList.remove("hidden"); empty.classList.add("hidden"); list.classList.add("hidden");
  try {
    const res = await api.getMatches(matchFilter);
    loading.classList.add("hidden");
    if (!res || !res.ok) { empty.classList.remove("hidden"); empty.textContent = (res && res.error) || "Couldn't load matches."; return; }
    renderMatches(res);
    matchesLoaded = true;
  } catch (e) { loading.classList.add("hidden"); empty.classList.remove("hidden"); empty.textContent = "Couldn't load matches."; }
}

function renderMatches(res) {
  const ver = res.version, list = $("mh-list");
  // summary line
  const s = res.summary || { w: 0, l: 0, games: 0, kda: 0 };
  $("mh-summary").textContent = s.games ? `Last ${s.games} · ${s.w}W ${s.l}L · ${s.kda} KDA` : "No ranked games";

  // champion performance
  const cp = $("cp-list"); cp.innerHTML = "";
  const champs = res.champs || [];
  $("cp-empty").classList.toggle("hidden", champs.length > 0);
  cp.classList.toggle("hidden", champs.length === 0);
  for (const c of champs) {
    const li = document.createElement("li");
    const img = document.createElement("img"); img.className = "cp-icon"; img.src = champImg(ver, c.champKey); img.onerror = () => (img.style.visibility = "hidden");
    const name = document.createElement("div"); name.className = "cp-name"; name.innerHTML = `${c.champion}<span class="cp-sub">${c.games} games · ${c.kda} KDA</span>`;
    const wr = document.createElement("div"); wr.className = "cp-wr " + (c.wr >= 50 ? "pos" : "neg"); wr.textContent = c.wr + "%";
    li.append(img, name, wr); cp.append(li);
  }

  // matches
  list.innerHTML = "";
  const matches = res.matches || [];
  if (matches.length === 0) { $("mh-empty").classList.remove("hidden"); $("mh-empty").textContent = "No matches found for this filter."; return; }
  $("mh-empty").classList.add("hidden"); list.classList.remove("hidden");
  for (const m of matches) {
    const li = document.createElement("li");
    li.className = "match " + (m.remake ? "remake" : m.win ? "win" : "loss");
    const icon = document.createElement("img"); icon.className = "m-champ"; icon.src = champImg(ver, m.champKey); icon.onerror = () => (icon.style.visibility = "hidden");
    const main = document.createElement("div"); main.className = "m-main";
    main.innerHTML =
      `<div class="m-top"><span class="m-res">${m.remake ? "Remake" : m.win ? "Victory" : "Defeat"}</span>` +
      `<span class="m-q">${m.queue}</span></div>` +
      `<div class="m-bot"><span class="m-when">${timeAgo(m.endTs)} · ${dur(m.durationSec)}</span></div>`;
    const stats = document.createElement("div"); stats.className = "m-stats";
    stats.innerHTML =
      `<div class="m-kda"><b>${m.k} / <span class="d">${m.d}</span> / ${m.a}</b><span class="m-kdar">${m.kda} KDA</span></div>` +
      `<div class="m-cs">${m.cs} CS · ${m.csPerMin}/min</div>`;
    const items = document.createElement("div"); items.className = "m-items";
    for (const it of (m.items || [])) {
      const cell = document.createElement("span"); cell.className = "m-item";
      if (it) { const im = document.createElement("img"); im.src = itemImg(ver, it); im.onerror = () => (cell.classList.add("empty")); cell.append(im); }
      else cell.classList.add("empty");
      items.append(cell);
    }
    li.append(icon, main, stats, items); list.append(li);
  }
}

// ===== Data loop =====
async function refresh() { try { render(await api.getHome()); } catch (_) {} }

// ===== AI prediction =====
$("predict-btn").addEventListener("click", async () => {
  const btn = $("predict-btn"), out = $("predict-out");
  btn.disabled = true; out.classList.remove("hidden"); out.classList.add("loading"); out.textContent = "Forecasting your climb…";
  try {
    const res = await api.predictRankUp();
    out.classList.remove("loading");
    out.textContent = res && res.text ? res.text : (res && res.error) || "Couldn't generate a forecast.";
  } catch (e) { out.classList.remove("loading"); out.textContent = "Forecast failed: " + (e && e.message ? e.message : "error"); }
  finally { btn.disabled = false; }
});

// ===== Settings: AI save + re-link =====
let settingsDirty = false;
$("set-key").addEventListener("input", () => (settingsDirty = true));
$("set-baseline").addEventListener("input", () => (settingsDirty = true));
$("set-save").addEventListener("click", async () => {
  const st = $("set-status");
  try {
    await api.saveSettings({ anthropicApiKey: $("set-key").value.trim(), baselineApiUrl: $("set-baseline").value.trim() });
    settingsDirty = false; st.textContent = "Saved"; st.classList.add("show"); setTimeout(() => st.classList.remove("show"), 1800);
  } catch (_) { st.textContent = "Save failed"; st.classList.add("show"); }
});
$("set-relink").addEventListener("click", () => {
  if (lastSettings) { $("su-riotid").value = lastSettings.riotId || ""; }
  loadRegions().then(() => { if (lastSettings && lastSettings.region) $("su-region").value = lastSettings.region; });
  showSetup(true);
});
$("lm-review").addEventListener("click", () => api.openReview && api.openReview());

// ===== Appearance (live theming) =====
const ACCENTS = ["#36d6d6", "#4f9dff", "#a06bff", "#ff5d9e", "#46c98a", "#d9b35e", "#ff6b5d"];
const ROWS = [["csm", "CSM"], ["gpm", "GPM"], ["vision", "VIS"], ["kp", "KP%"], ["kda", "KDA"], ["lvl", "LVL"]];

// Build swatches + row chips once
(function buildAppearance() {
  const sw = $("swatches");
  ACCENTS.forEach((c) => { const b = document.createElement("button"); b.className = "sw"; b.style.background = c; b.dataset.c = c; b.addEventListener("click", () => saveTheme({ accent: c })); sw.append(b); });
  const rt = $("row-toggles");
  ROWS.forEach(([key, lbl]) => { const b = document.createElement("button"); b.className = "chip"; b.textContent = lbl; b.dataset.row = key; b.addEventListener("click", () => { const cur = currentTheme(); const rows = { ...(cur.overlay.rows || {}) }; rows[key] = !rows[key]; saveTheme({ overlay: { rows } }); }); rt.append(b); });
})();

$("accent-custom").addEventListener("input", (e) => saveTheme({ accent: e.target.value }));
$("seg-theme").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => saveTheme({ theme: b.dataset.v })));
$("seg-density").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => saveTheme({ density: b.dataset.v })));
$("rng-font").addEventListener("input", (e) => saveTheme({ fontScale: parseFloat(e.target.value) }));
$("rng-ovscale").addEventListener("input", (e) => saveTheme({ overlay: { scale: parseFloat(e.target.value) } }));
$("rng-ovop").addEventListener("input", (e) => saveTheme({ overlay: { opacity: parseFloat(e.target.value) } }));

let _theme = null;
const currentTheme = () => _theme || { theme: "dark", accent: "#36d6d6", density: "comfortable", fontScale: 1, overlay: { scale: 1, opacity: 1, rows: {} } };
async function saveTheme(patch) { try { _theme = await api.saveTheme(patch); syncAppearance(_theme); } catch (_) {} }

function syncAppearance(t) {
  if (!t) return; _theme = t;
  $("seg-theme").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === t.theme));
  $("seg-density").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === t.density));
  document.querySelectorAll("#swatches .sw").forEach((s) => s.classList.toggle("active", s.dataset.c.toLowerCase() === (t.accent || "").toLowerCase()));
  $("accent-custom").value = /^#[0-9a-fA-F]{6}$/.test(t.accent) ? t.accent : "#36d6d6";
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
