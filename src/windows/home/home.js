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
  lastHome = data;

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

  // Settings: account + AI fields
  $("set-riotid").textContent = (settings && settings.riotId) || "Not linked";
  $("set-region").textContent = (settings && settings.region) || "—";
  if (!settingsDirty) {
    if (document.activeElement !== $("set-key")) $("set-key").value = (settings && settings.anthropicApiKey) || "";
    if (document.activeElement !== $("set-baseline")) $("set-baseline").value = (settings && settings.baselineApiUrl) || "";
    setClaudeMode(!!(settings && settings.coachUseClaude));
  }
}

// ===== Match history (Progress page) =====
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
const kFmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

function updateProfileIcon() {
  const sm = lastHome && lastHome.summary && lastHome.summary.summoner;
  const el = $("prof-icon");
  if (el && sm && sm.profileIconId != null && ddVersion) {
    el.src = `https://ddragon.leagueoflegends.com/cdn/${ddVersion}/img/profileicon/${sm.profileIconId}.png`;
    el.style.visibility = "visible";
  } else if (el) { el.style.visibility = "hidden"; }
}

function drawLpGraph(history) {
  const pts = (history || []).filter((e) => typeof e.score === "number");
  const empty = $("lp-graph-empty"), svg = $("lp-graph"), line = $("lp-line");
  if (pts.length < 2) { empty.classList.remove("hidden"); svg.classList.add("hidden"); return; }
  empty.classList.add("hidden"); svg.classList.remove("hidden");
  const scores = pts.map((e) => e.score);
  let min = Math.min(...scores), max = Math.max(...scores);
  if (max === min) { max += 1; min -= 1; }
  const W = 240, H = 90, pad = 8, n = pts.length;
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
      `<div class="m-extra">P/Kill ${m.kp}% · ${kFmt(m.dmg)} dmg</div>`;

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

    const caret = document.createElement("button"); caret.className = "m-caret"; caret.textContent = "▾"; caret.title = "Match details";
    const detail = buildDetail(m, ver);
    const toggle = () => { const open = detail.classList.toggle("hidden"); caret.classList.toggle("open", !open); };
    caret.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    li.addEventListener("click", toggle);

    li.append(idCol, main, stats, items, parts, caret, detail); list.append(li);
  }
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

// ===== Settings: AI save + re-link =====
let settingsDirty = false;
let claudeMode = false;
function setClaudeMode(on) {
  claudeMode = !!on;
  $("seg-claude").querySelectorAll("button").forEach((b) => b.classList.toggle("active", (b.dataset.v === "on") === claudeMode));
}
$("seg-claude").querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => { setClaudeMode(b.dataset.v === "on"); settingsDirty = true; })
);
$("set-key").addEventListener("input", () => (settingsDirty = true));
$("set-baseline").addEventListener("input", () => (settingsDirty = true));
$("set-save").addEventListener("click", async () => {
  const st = $("set-status");
  try {
    await api.saveSettings({ anthropicApiKey: $("set-key").value.trim(), baselineApiUrl: $("set-baseline").value.trim(), coachUseClaude: claudeMode });
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
