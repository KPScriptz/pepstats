"use strict";

const $ = (id) => document.getElementById(id);
const api = window.pepstats || {};

// ---- Window controls ----
$("tb-min").addEventListener("click", () => api.winMin && api.winMin());
$("tb-close").addEventListener("click", () => api.winClose && api.winClose());

// ---- Helpers ----
const PHASE_LABEL = {
  None: "Idle", Lobby: "In lobby", Matchmaking: "In queue",
  ReadyCheck: "Ready check", ChampSelect: "Champ select",
  InProgress: "In game", WaitingForStats: "Loading results",
  PreEndOfGame: "Post-game", EndOfGame: "Post-game",
};

function signedLp(n) {
  if (n == null) return "—";
  return (n >= 0 ? "+" : "−") + Math.abs(n);
}

// ---- First-run setup ----
let regionsLoaded = false;
async function loadRegions() {
  if (regionsLoaded || !api.getRiotRegions) return;
  try {
    const regions = await api.getRiotRegions();
    const sel = $("su-region");
    sel.innerHTML = "";
    for (const r of regions || []) {
      const o = document.createElement("option");
      o.value = r.code;
      o.textContent = r.label + " (" + r.code + ")";
      sel.append(o);
    }
    regionsLoaded = true;
  } catch (_) {
    /* ignore */
  }
}

function showSetup(show) {
  $("setup").classList.toggle("hidden", !show);
  document.querySelector("main.client").classList.toggle("hidden", show);
  if (show) loadRegions();
}

$("su-connect").addEventListener("click", async () => {
  const btn = $("su-connect");
  const err = $("su-error");
  err.classList.add("hidden");
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Connecting…";
  try {
    const res = await api.connectRiot({
      riotId: $("su-riotid").value,
      region: $("su-region").value,
      riotApiKey: $("su-key").value,
    });
    if (res && res.ok) {
      showSetup(false);
      refresh();
    } else {
      err.textContent = (res && res.error) || "Couldn't connect. Check your details.";
      err.classList.remove("hidden");
    }
  } catch (e) {
    err.textContent = "Connection failed: " + (e && e.message ? e.message : "unknown error");
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
});

$("su-skip").addEventListener("click", async () => {
  try {
    await api.skipRiot();
  } catch (_) {}
  showSetup(false);
  refresh();
});

// ---- Render ----
function render(data) {
  if (!data) return;
  if (data.needsSetup) {
    showSetup(true);
    return;
  }
  showSetup(false);
  const { summary, status, settings, lastMatch } = data;

  // Hero: rank
  const p = (summary && summary.progress) || {};
  const solo = summary && summary.solo;
  $("rank-now").textContent = p.label || "Unranked";
  $("emblem-letter").textContent = solo && solo.tier ? solo.tier[0] : "?";
  $("rank-next").textContent = p.next ? "Next: " + p.next : "Play ranked to start tracking";
  const div = p.division || { pct: 0, lp: 0, toNext: 100 };
  $("lp-fill").style.width = (solo ? div.pct : 0) + "%";
  $("lp-text").textContent = solo
    ? `${div.lp} LP · ${div.toNext} to ${p.next || "promo"}`
    : "Unranked";

  // Hero KPIs
  const wk = (summary && summary.weekly) || {};
  const wkEl = $("kpi-weekly");
  if (wk.tracking || wk.gain == null) {
    wkEl.textContent = "tracking…";
    wkEl.className = "kpi-val";
    wkEl.style.fontSize = "13px";
  } else {
    wkEl.textContent = signedLp(wk.gain) + " LP";
    wkEl.className = "kpi-val " + (wk.gain > 0 ? "pos" : wk.gain < 0 ? "neg" : "");
    wkEl.style.fontSize = "";
  }
  $("kpi-level").textContent =
    summary && summary.summoner && summary.summoner.level ? summary.summoner.level : "—";
  $("kpi-wr").textContent = p.winRate != null ? p.winRate + "%" : "—";

  // Status card
  const clientUp = status && status.clientUp;
  const cl = $("st-client");
  cl.textContent = clientUp ? "Connected" : "Offline";
  cl.className = "pill " + (clientUp ? "on" : "off");
  $("st-phase").textContent = (status && PHASE_LABEL[status.phase]) || "Idle";
  const sm = summary && summary.summoner;
  $("st-summoner").textContent = sm && sm.name ? sm.name + (sm.tagLine ? "#" + sm.tagLine : "") : "—";

  // Last match
  if (lastMatch && lastMatch.champion) {
    $("lm-empty").classList.add("hidden");
    $("lm-body").classList.remove("hidden");
    $("lm-champ").textContent = lastMatch.champion;
    const k = lastMatch.kda || { k: 0, d: 0, a: 0 };
    $("lm-kda").textContent = `${k.k} / ${k.d} / ${k.a}`;
    $("lm-cs").textContent =
      `${Math.round(lastMatch.cs || 0)} (${(lastMatch.csPerMin || 0).toFixed(1)}/min)`;
  } else {
    $("lm-empty").classList.remove("hidden");
    $("lm-body").classList.add("hidden");
  }

  // Recent history
  const hist = (data.history || []).slice().reverse();
  if (hist.length >= 2) {
    $("hist-empty").classList.add("hidden");
    const list = $("hist-list");
    list.classList.remove("hidden");
    list.innerHTML = "";
    for (let i = 0; i < hist.length && i < 6; i++) {
      const e = hist[i];
      const prev = hist[i + 1];
      const li = document.createElement("li");
      const left = document.createElement("span");
      left.innerHTML = `${e.day} · <b>${e.tier ? e.tier[0] + (e.division || "") : "—"} ${e.lp}LP</b>`;
      const right = document.createElement("span");
      if (prev && typeof e.score === "number" && typeof prev.score === "number") {
        const d = e.score - prev.score;
        right.className = "delta " + (d > 0 ? "pos" : d < 0 ? "neg" : "");
        right.textContent = signedLp(d);
      } else {
        right.textContent = "—";
      }
      li.append(left, right);
      list.append(li);
    }
  } else {
    $("hist-empty").classList.remove("hidden");
    $("hist-list").classList.add("hidden");
  }

  // Settings (only fill if user isn't editing)
  if (settings && !settingsDirty) {
    if (document.activeElement !== $("set-key")) $("set-key").value = settings.anthropicApiKey || "";
    if (document.activeElement !== $("set-baseline")) $("set-baseline").value = settings.baselineApiUrl || "";
  }

  $("foot-refresh").textContent = "Updated " + new Date().toLocaleTimeString();
}

// ---- Data loop ----
async function refresh() {
  try {
    const data = await api.getHome();
    render(data);
  } catch (_) {
    /* ignore */
  }
}

// ---- AI prediction ----
$("predict-btn").addEventListener("click", async () => {
  const btn = $("predict-btn");
  const out = $("predict-out");
  btn.disabled = true;
  out.classList.remove("hidden");
  out.classList.add("loading");
  out.textContent = "Forecasting your climb…";
  try {
    const res = await api.predictRankUp();
    out.classList.remove("loading");
    if (res && res.text) {
      out.textContent = res.text;
    } else {
      out.textContent = (res && res.error) || "Couldn't generate a forecast.";
    }
  } catch (e) {
    out.classList.remove("loading");
    out.textContent = "Forecast failed: " + (e && e.message ? e.message : "unknown error");
  } finally {
    btn.disabled = false;
  }
});

// ---- Settings ----
let settingsDirty = false;
$("set-key").addEventListener("input", () => (settingsDirty = true));
$("set-baseline").addEventListener("input", () => (settingsDirty = true));

$("set-save").addEventListener("click", async () => {
  const payload = {
    anthropicApiKey: $("set-key").value.trim(),
    baselineApiUrl: $("set-baseline").value.trim(),
  };
  const st = $("set-status");
  try {
    await api.saveSettings(payload);
    settingsDirty = false;
    st.textContent = "Saved";
    st.classList.add("show");
    setTimeout(() => st.classList.remove("show"), 1800);
  } catch (e) {
    st.textContent = "Save failed";
    st.classList.add("show");
  }
});

$("set-reposition").addEventListener("click", () => api.repositionOverlay && api.repositionOverlay());
$("lm-review").addEventListener("click", () => api.openReview && api.openReview());

// ---- Boot ----
if (api.onHome) api.onHome(() => refresh());
refresh();
setInterval(refresh, 5000);
