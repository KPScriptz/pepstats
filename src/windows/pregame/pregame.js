"use strict";

document.getElementById("close").addEventListener("click", () => window.close());

const el = {
  phase: document.getElementById("phase"),
  phaseDot: document.getElementById("phase-dot"),
  ally: document.getElementById("ally"),
  enemy: document.getElementById("enemy"),
  gaugeArc: document.getElementById("gauge-arc"),
  synergyScore: document.getElementById("synergy-score"),
  synergyNote: document.getElementById("synergy-note"),
  chipPhase: document.getElementById("chip-phase"),
  chipPick: document.getElementById("chip-pick"),
  chipLocked: document.getElementById("chip-locked"),
  importDot: document.getElementById("import-dot"),
  importLabel: document.getElementById("import-label"),
  importStatus: document.getElementById("import-status"),
  importBtn: document.getElementById("import"),
  buildChamp: document.getElementById("build-champ"),
  buildTabs: document.getElementById("build-tabs"),
  buildEmpty: document.getElementById("build-empty"),
  buildBody: document.getElementById("build-body"),
  bRunes: document.getElementById("b-runes"),
  bSpells: document.getElementById("b-spells"),
  bSkills: document.getElementById("b-skills"),
  bStart: document.getElementById("b-start"),
  bCore: document.getElementById("b-core"),
  draftCounters: document.getElementById("draft-counters"),
  draftSynergies: document.getElementById("draft-synergies"),
};

let pickedChampId = 0; // the local player's locked champion (for rune import)

// Champ-select ally recent form (cellId -> ally object from get-lobby-allies).
let lastSession = null;
let allyForm = {};
let alliesFetchedAt = 0;
let alliesKey = "";

const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 52; // r=52 in the SVG
const ROLE_SHORT = { TOP: "TOP", JUNGLE: "JNG", MIDDLE: "MID", BOTTOM: "BOT", UTILITY: "SUP" };

// Champion index (numeric id -> name + Data Dragon id) for names + portraits.
let CHAMPS = { version: null, byId: {} };
if (window.pepstats.getChampions) {
  window.pepstats.getChampions().then((c) => { if (c) { CHAMPS = c; refresh(); } }).catch(() => {});
}
const champName = (id) => (CHAMPS.byId[id] && CHAMPS.byId[id].name) || (id > 0 ? "Champion #" + id : "Picking…");
const champIcon = (id) => (CHAMPS.version && CHAMPS.byId[id]) ? `https://ddragon.leagueoflegends.com/cdn/${CHAMPS.version}/img/champion/${CHAMPS.byId[id].id}.png` : null;

function setDot(node, kind) {
  node.className = "dot dot-" + kind;
}

// Draft completeness drives the gauge as an honest placeholder for the full
// synergy model (which would need champion data we don't pull yet).
function setGauge(lockedCount, total) {
  const frac = total > 0 ? lockedCount / total : 0;
  el.gaugeArc.setAttribute(
    "stroke-dasharray",
    `${(frac * GAUGE_CIRCUMFERENCE).toFixed(1)} ${GAUGE_CIRCUMFERENCE.toFixed(1)}`
  );
  if (lockedCount === 0) {
    el.synergyScore.textContent = "—";
  } else {
    el.synergyScore.textContent = Math.round(frac * 100);
  }
}

function champLabel(championId) {
  return champName(championId);
}

function statChip(label, value) {
  const chip = document.createElement("div");
  const has = value != null && value !== "";
  chip.className = "stat-chip" + (has ? "" : " placeholder");
  const v = document.createElement("span");
  v.className = "sv";
  v.textContent = has ? value : "—";
  const k = document.createElement("span");
  k.className = "sk";
  k.textContent = label;
  chip.append(v, k);
  return chip;
}

function renderTeam(container, members, localCellId, withStats) {
  if (!members || !members.length) return;
  container.innerHTML = "";
  for (const m of members) {
    const row = document.createElement("div");
    row.className = "player-row" + (m.cellId === localCellId ? " is-you" : "");

    const icon = document.createElement("img");
    icon.className = "player-icon";
    const iurl = champIcon(m.championId);
    if (iurl) { icon.src = iurl; icon.onerror = () => (icon.style.visibility = "hidden"); }
    else icon.classList.add("empty");
    row.append(icon);

    const role = document.createElement("div");
    role.className = "role-badge";
    role.textContent = ROLE_SHORT[m.assignedPosition] || "—";

    const main = document.createElement("div");
    main.className = "player-main";
    const champ = document.createElement("span");
    champ.className = "player-champ";
    champ.textContent = champLabel(m.championId);
    const form = withStats ? allyForm[m.cellId] : null;
    const recent = form && form.recent && form.recent.games ? form.recent : null;

    const sub = document.createElement("span");
    sub.className = "player-sub";
    sub.textContent =
      m.cellId === localCellId ? "You"
      : (form && form.label) ? form.label
      : (m.assignedPosition ? ROLE_SHORT[m.assignedPosition] + " lane" : "Assigned role");
    main.append(champ, sub);

    row.append(role, main);

    if (withStats) {
      const stats = document.createElement("div");
      stats.className = "player-stats";
      if (recent) {
        // Real recent-5 form pulled from the official match-v5 API.
        stats.append(
          statChip("WR", recent.wr != null ? recent.wr + "%" : null),
          statChip("KDA", recent.kda != null ? Number(recent.kda).toFixed(1) : null),
          statChip("MAIN", recent.topChamp || null)
        );
      } else {
        stats.append(statChip("WR"), statChip("MAIN"));
      }
      row.append(stats);
    }

    container.append(row);
  }
}

function resetIdle(message) {
  el.phase.textContent = message;
  setDot(el.phaseDot, "idle");
  el.chipPhase.textContent = "Idle";
  el.chipPick.textContent = "—";
  el.chipLocked.textContent = "0 / 5";
  setGauge(0, 5);
  setDot(el.importDot, "idle");
  el.importLabel.textContent = "Standby";
}

// Pull teammates' recent-5 win-rate + KDA once per champ-select roster (then at
// most every 30s). The main process 60s-caches by teammate set, so this stays
// light. On success we re-render the ally team so the real chips replace the
// placeholders. Quietly no-ops when the Riot account isn't linked.
function maybeLoadAllies(session) {
  if (!session || !window.pepstats.getLobbyAllies) return;
  const team = (session.myTeam || []).filter((m) => m && m.cellId !== session.localPlayerCellId);
  const key = team.map((m) => m.cellId).sort().join(",");
  if (!key) return;
  const now = Date.now();
  if (key === alliesKey && now - alliesFetchedAt < 30000) return;
  alliesKey = key;
  alliesFetchedAt = now;
  window.pepstats
    .getLobbyAllies()
    .then((res) => {
      if (!res || !res.ok || !Array.isArray(res.allies)) return;
      const map = {};
      for (const a of res.allies) map[a.cellId] = a;
      allyForm = map;
      if (lastSession) renderTeam(el.ally, lastSession.myTeam || [], lastSession.localPlayerCellId, true);
    })
    .catch(() => {});
}

// ----- Draft coach (curated counters + synergies) -----
let draftKey = "";
let draftFetchedAt = 0;

function renderDraftList(container, items, emptyMsg) {
  container.innerHTML = "";
  if (!items || !items.length) {
    const m = document.createElement("span");
    m.className = "muted";
    m.textContent = emptyMsg;
    container.append(m);
    return;
  }
  for (const s of items) {
    const row = document.createElement("div");
    row.className = "draft-pick";
    const icon = document.createElement("img");
    icon.className = "draft-icon";
    if (s.icon) { icon.src = s.icon; icon.onerror = () => (icon.style.visibility = "hidden"); }
    const txt = document.createElement("div");
    txt.className = "draft-text";
    const name = document.createElement("span");
    name.className = "draft-name";
    name.textContent = s.name;
    const why = document.createElement("span");
    why.className = "draft-why";
    why.textContent = (s.vs && s.vs.length ? s.vs.join(", ") + " · " : "") + (s.reason || "");
    txt.append(name, why);
    row.append(icon, txt);
    container.append(row);
  }
}

// Pull curated counters/synergies for the current locks. Re-fetch only when the
// set of locked champions changes (or every 8s) so it tracks new picks live.
function maybeLoadDraft(session) {
  if (!session || !window.pepstats.getDraftAdvice) return;
  const locks = []
    .concat((session.myTeam || []).map((m) => m.championId || 0))
    .concat((session.theirTeam || []).map((m) => m.championId || 0))
    .filter(Boolean)
    .sort()
    .join(",");
  const now = Date.now();
  if (locks === draftKey && now - draftFetchedAt < 8000) return;
  draftKey = locks;
  draftFetchedAt = now;
  window.pepstats
    .getDraftAdvice()
    .then((res) => {
      if (!res || !res.ok) return;
      renderDraftList(el.draftCounters, res.counters, "No counter data for these picks yet.");
      renderDraftList(el.draftSynergies, res.synergies, "No synergy data for these picks yet.");
    })
    .catch(() => {});
}

function renderSession(session) {
  if (!session) {
    resetIdle("League client not detected. Open League and enter champ select.");
    return;
  }
  lastSession = session;
  maybeLoadAllies(session);
  maybeLoadDraft(session);

  el.phase.textContent = "Champ select in progress.";
  setDot(el.phaseDot, "active");
  el.chipPhase.textContent = "Champ Select";

  const myTeam = session.myTeam || [];
  const theirTeam = session.theirTeam || [];
  const localCellId = session.localPlayerCellId;

  renderTeam(el.ally, myTeam, localCellId, true);
  renderTeam(el.enemy, theirTeam, localCellId, false);

  const locked = myTeam.filter((m) => m.championId && m.championId > 0).length;
  el.chipLocked.textContent = `${locked} / ${Math.max(myTeam.length, 5)}`;
  setGauge(locked, Math.max(myTeam.length, 5));

  const me = myTeam.find((m) => m.cellId === localCellId);
  el.chipPick.textContent = me ? champLabel(me.championId) : "—";

  setDot(el.importDot, locked === myTeam.length && myTeam.length > 0 ? "active" : "warn");
  el.importLabel.textContent = locked === myTeam.length && myTeam.length > 0 ? "Ready" : "Waiting on locks";

  loadBuild(me ? me.championId : 0);
}

// ----- Curated build panel -----
function iconImg(url, cls) {
  const i = document.createElement("img");
  i.className = "b-icon" + (cls ? " " + cls : "");
  if (url) { i.src = url; i.onerror = () => i.classList.add("missing"); }
  else i.classList.add("missing");
  return i;
}

// Current curated build set: { champion, role, order:[names], variants:{name:build} }.
let buildSet = null;
let activeVariant = "";

// Render just the runes / skills / items of one resolved variant.
function renderVariant(b) {
  el.bRunes.innerHTML = "";
  el.bRunes.append(iconImg(b.runes.keystone, "key"));
  for (const u of b.runes.perks) el.bRunes.append(iconImg(u, "rune"));
  const sep = document.createElement("span"); sep.className = "b-sep"; el.bRunes.append(sep);
  el.bRunes.append(iconImg(b.runes.sub, "rune"));
  for (const u of b.runes.sec) el.bRunes.append(iconImg(u, "rune"));

  el.bSpells.innerHTML = ""; for (const u of b.spells) el.bSpells.append(iconImg(u));
  el.bSkills.textContent = (b.skills || []).join(" → ");
  el.bStart.innerHTML = ""; for (const u of b.start) el.bStart.append(iconImg(u));
  el.bCore.innerHTML = "";
  b.core.forEach((u, i) => { if (i) { const a = document.createElement("span"); a.className = "b-arrow"; a.textContent = "›"; el.bCore.append(a); } el.bCore.append(iconImg(u)); });
}

// Switch to a variant by name and refresh the displayed build + tab state.
function selectVariant(name) {
  if (!buildSet || !buildSet.variants[name]) return;
  activeVariant = name;
  renderVariant(buildSet.variants[name]);
  el.buildTabs.querySelectorAll(".build-tab").forEach((t) => t.classList.toggle("active", t.dataset.v === name));
}

function renderBuild(payload) {
  buildSet = null; activeVariant = "";
  el.buildTabs.innerHTML = ""; el.buildTabs.classList.add("hidden");
  if (!payload || payload.none || payload.error || !payload.variants) {
    el.buildBody.classList.add("hidden");
    el.buildEmpty.classList.remove("hidden");
    el.buildEmpty.textContent = payload && payload.champion
      ? `No curated build for ${payload.champion} yet.`
      : "Lock in a champion to see a curated build.";
    el.buildChamp.textContent = (payload && payload.champion) || "";
    return;
  }
  buildSet = payload;
  el.buildEmpty.classList.add("hidden");
  el.buildBody.classList.remove("hidden");
  el.buildChamp.textContent = payload.champion + (payload.role ? " · " + payload.role : "");

  // Build the segmented variant tabs.
  el.buildTabs.classList.remove("hidden");
  for (const name of payload.order) {
    const tab = document.createElement("button");
    tab.className = "build-tab";
    tab.dataset.v = name;
    tab.textContent = name;
    tab.addEventListener("click", () => selectVariant(name));
    el.buildTabs.append(tab);
  }
  selectVariant(payload.order[0]);
}

async function loadBuild(championId) {
  pickedChampId = championId || 0;
  if (!pickedChampId || !window.pepstats.getBuild) { renderBuild(null); return; }
  try {
    const payload = await window.pepstats.getBuild(pickedChampId);
    renderBuild(payload);
    // Champion Sync: tint the app accent to the picked champion.
    const enabled = !(window.__pepTheme && window.__pepTheme.championSync === false);
    if (window.syncAppTheme) window.syncAppTheme(payload && payload.champion, enabled);
  } catch (_) { renderBuild(null); }
}

async function refresh() {
  let session = null;
  try {
    session = await window.pepstats.getPregame();
  } catch (_) {
    session = null;
  }
  renderSession(session);
}

// Live push from the LCU event socket (instant updates between polls).
window.pepstats.onChampSelect((session) => renderSession(session));

el.importBtn.addEventListener("click", async () => {
  if (!pickedChampId) {
    el.importStatus.textContent = "Lock in a champion first.";
    return;
  }
  if (!window.pepstats.importRunes) {
    el.importStatus.textContent = "Rune import unavailable.";
    return;
  }
  el.importBtn.disabled = true;
  el.importStatus.textContent = "Importing rune page…";
  try {
    const res = await window.pepstats.importRunes(pickedChampId, activeVariant);
    if (res && res.ok) {
      const what = res.items ? "runes + items" : "runes";
      el.importStatus.textContent = `Imported "${res.variant || "Standard Core"}" ${what} — check your client.`;
      setDot(el.importDot, "active");
      el.importLabel.textContent = "Imported";
    } else {
      el.importStatus.textContent = (res && res.error) || "Import failed (is the client open?).";
      setDot(el.importDot, "warn");
    }
  } catch (err) {
    el.importStatus.textContent = "Import failed: " + (err && err.message ? err.message : "unknown error");
    setDot(el.importDot, "warn");
  } finally {
    el.importBtn.disabled = false;
  }
});

refresh();
setInterval(refresh, 3000);
