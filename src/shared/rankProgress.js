"use strict";

// Ranked progression data for the home/client window: current rank, LP, next
// rank, account level, and a locally-tracked weekly LP gain. Everything is read
// from the LCU (gray-area reads only). Weekly gain is not exposed by any API, so
// we snapshot the solo-queue LP locally (one point per day) and diff it.

const fs = require("fs");
const path = require("path");

const TIERS = [
  "IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM",
  "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER",
];
const DIV_NUM = { I: 1, II: 2, III: 3, IV: 4 };
const APEX = TIERS.indexOf("MASTER"); // Master+ have no divisions

const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : "");
const ROMAN = { 1: "I", 2: "II", 3: "III", 4: "IV" };

// ----- LCU reads -----------------------------------------------------------
async function getSummoner(lcu) {
  try {
    const s = await lcu.request("/lol-summoner/v1/current-summoner");
    if (!s) return null;
    return {
      name: s.gameName || s.displayName || "",
      tagLine: s.tagLine || "",
      level: s.summonerLevel || 0,
      profileIconId: s.profileIconId || 0,
    };
  } catch (_) {
    return null;
  }
}

function parseEntry(e) {
  if (!e || !e.tier) return null;
  const tier = String(e.tier).toUpperCase();
  if (!TIERS.includes(tier)) return null; // unranked -> tier "" / "NONE"
  return {
    tier,
    division: e.division && e.division !== "NA" ? e.division : "",
    lp: typeof e.leaguePoints === "number" ? e.leaguePoints : 0,
    wins: e.wins || 0,
    losses: e.losses || 0,
  };
}

async function getRanked(lcu) {
  try {
    const r = await lcu.request("/lol-ranked/v1/current-ranked-stats");
    const qm = (r && r.queueMap) || {};
    return {
      solo: parseEntry(qm.RANKED_SOLO_5x5),
      flex: parseEntry(qm.RANKED_FLEX_SR),
    };
  } catch (_) {
    return null;
  }
}

// ----- Rank math -----------------------------------------------------------
// A monotonic score so LP gains compute cleanly across divisions/tiers.
function rankScore(entry) {
  if (!entry || !entry.tier) return null;
  const ti = TIERS.indexOf(entry.tier);
  if (ti < 0) return null;
  if (ti >= APEX) return ti * 400 + entry.lp; // no divisions above Diamond
  const divVal = (4 - (DIV_NUM[entry.division] || 4)) * 100; // IV=0 … I=300
  return ti * 400 + divVal + entry.lp;
}

function nextRankLabel(entry) {
  if (!entry || !entry.tier) return null;
  const ti = TIERS.indexOf(entry.tier);
  if (entry.tier === "CHALLENGER") return "Rank 1";
  if (ti >= APEX) return TIERS[ti + 1] ? cap(TIERS[ti + 1]) : "Rank 1";
  const div = DIV_NUM[entry.division] || 4;
  if (div > 1) return cap(entry.tier) + " " + ROMAN[div - 1];
  // Promoting out of division I into the next tier. Master+ have no divisions.
  const nextTi = ti + 1;
  return nextTi >= APEX ? cap(TIERS[nextTi]) : cap(TIERS[nextTi]) + " IV";
}

// LP within the current division (0..100) and what's needed to promote.
function divisionProgress(entry) {
  if (!entry || !entry.tier) return { lp: 0, toNext: 100, pct: 0 };
  const lp = Math.max(0, Math.min(100, entry.lp));
  return { lp, toNext: Math.max(0, 100 - lp), pct: Math.round(lp) };
}

function label(entry) {
  if (!entry || !entry.tier) return "Unranked";
  const ti = TIERS.indexOf(entry.tier);
  return ti >= APEX
    ? cap(entry.tier) + " " + entry.lp + " LP"
    : cap(entry.tier) + " " + (entry.division || "IV");
}

// ----- Weekly LP tracking (local snapshots) --------------------------------
const histFile = (dir) => path.join(dir, "lpHistory.json");

function loadHist(dir) {
  try {
    const h = JSON.parse(fs.readFileSync(histFile(dir), "utf8"));
    return Array.isArray(h) ? h : [];
  } catch (_) {
    return [];
  }
}

function saveHist(dir, h) {
  try {
    fs.writeFileSync(histFile(dir), JSON.stringify(h));
  } catch (_) {
    /* best-effort */
  }
}

// Record at most one snapshot per calendar day (updates the day's last value).
function recordSnapshot(dir, solo) {
  if (!dir || !solo || !solo.tier) return;
  const score = rankScore(solo);
  if (score == null) return;
  const h = loadHist(dir);
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const last = h[h.length - 1];
  if (last && last.day === day) {
    last.score = score;
    last.lp = solo.lp;
    last.ts = now;
  } else {
    h.push({ day, ts: now, score, lp: solo.lp, tier: solo.tier, division: solo.division });
  }
  while (h.length > 120) h.shift(); // ~4 months is plenty
  saveHist(dir, h);
}

// Net rank-score change over the last 7 days. `tracking` is true until we have a
// baseline old enough to be meaningful.
function weeklyGain(dir, solo) {
  if (!solo) return { gain: null, tracking: true };
  const cur = rankScore(solo);
  if (cur == null) return { gain: null, tracking: true };
  const h = loadHist(dir);
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const within = h.filter((e) => e.ts >= weekAgo);
  if (within.length === 0) return { gain: null, tracking: true };
  const base = within[0].score;
  return { gain: cur - base, tracking: h.length < 2, since: within[0].day };
}

// One call the home window uses to render everything. `dir` = a writable dir
// (the app's userData) for the LP-history file.
async function summary(lcu, dir) {
  const [summoner, ranked] = await Promise.all([getSummoner(lcu), getRanked(lcu)]);
  const solo = ranked && ranked.solo;
  if (solo) recordSnapshot(dir, solo);

  const games = solo ? solo.wins + solo.losses : 0;
  const winRate = games > 0 ? Math.round((solo.wins / games) * 100) : null;

  return {
    summoner,
    ranked,
    solo,
    progress: {
      label: label(solo),
      next: nextRankLabel(solo),
      division: divisionProgress(solo),
      winRate,
      wins: solo ? solo.wins : 0,
      losses: solo ? solo.losses : 0,
    },
    weekly: weeklyGain(dir, solo),
  };
}

// The raw LP-history snapshots, for the home window's "recent progress" list.
function history(dir) {
  return loadHist(dir);
}

module.exports = {
  getSummoner,
  getRanked,
  summary,
  rankScore,
  nextRankLabel,
  label,
  recordSnapshot,
  weeklyGain,
  history,
  TIERS,
};
