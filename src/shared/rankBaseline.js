"use strict";

// Rank-based performance baselines. Replaces the old lane-opponent comparison
// with "you vs the average player at your rank" — which, unlike a lane matchup,
// is well-defined in every mode (ARAM, URF, etc.) where there is no opponent in
// your role.
//
// Data-source priority:
//   1. External stats API (config.baselineApiUrl) — the live, pluggable source.
//      The URL may contain {rank}/{role}/{mode} placeholders and must return
//      JSON with any of: csmPerMin, kp, kda, visionPerMin (aliases accepted).
//   2. Baked-in TABLE below — graceful fallback so the overlay still shows a
//      comparison when the API is unset, unreachable, or returns junk.
//
// Account rank is read from the LCU (Solo/Duo, falling back to Flex). All
// numbers are approximate and drift by patch/season — treat them as tunable.

const https = require("https");
const http = require("http");

const TIERS = [
  "IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM",
  "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER",
];
const DEFAULT_TIER = "EMERALD"; // sensible median when rank is unknown/unranked

// Per-tier laner baselines: CS/min, KP%, KDA ratio, vision score/min.
const TABLE = {
  IRON:        { csm: 4.5, kp: 46, kda: 2.1, vpm: 0.70 },
  BRONZE:      { csm: 5.0, kp: 47, kda: 2.2, vpm: 0.75 },
  SILVER:      { csm: 5.4, kp: 48, kda: 2.3, vpm: 0.80 },
  GOLD:        { csm: 5.8, kp: 49, kda: 2.5, vpm: 0.88 },
  PLATINUM:    { csm: 6.2, kp: 50, kda: 2.6, vpm: 0.95 },
  EMERALD:     { csm: 6.5, kp: 51, kda: 2.7, vpm: 1.02 },
  DIAMOND:     { csm: 7.0, kp: 53, kda: 2.9, vpm: 1.12 },
  MASTER:      { csm: 7.6, kp: 55, kda: 3.1, vpm: 1.22 },
  GRANDMASTER: { csm: 7.9, kp: 56, kda: 3.2, vpm: 1.28 },
  CHALLENGER:  { csm: 8.2, kp: 58, kda: 3.4, vpm: 1.35 },
};

// Role adjustments. CS is multiplicative (supports/junglers farm far less);
// KP is additive (they participate in more kills); vision is multiplicative.
const ROLE = {
  TOP:     { csm: 1.00, kp: -3,  vpm: 1.0 },
  MIDDLE:  { csm: 1.05, kp:  0,  vpm: 1.0 },
  BOTTOM:  { csm: 1.10, kp:  2,  vpm: 0.9 },
  JUNGLE:  { csm: 0.90, kp:  8,  vpm: 1.3 },
  UTILITY: { csm: 0.25, kp: 10,  vpm: 2.4 },
  DEFAULT: { csm: 1.00, kp:  0,  vpm: 1.0 },
};

function normTier(tier) {
  const t = String(tier || "").toUpperCase();
  return TIERS.includes(t) ? t : null;
}

function normRole(role) {
  const r = String(role || "").toUpperCase();
  return ROLE[r] ? r : "DEFAULT";
}

// The baked-in baseline for a given rank + role. Always returns a usable object.
function tableBaseline(tier, role) {
  const t = normTier(tier) || DEFAULT_TIER;
  const r = normRole(role);
  const base = TABLE[t];
  const adj = ROLE[r];
  return {
    rank: t,
    role: r,
    csmPerMin: +(base.csm * adj.csm).toFixed(2),
    kp: Math.round(base.kp + adj.kp),
    kda: +base.kda.toFixed(2),
    visionPerMin: +(base.vpm * adj.vpm).toFixed(2),
    source: "table",
  };
}

// ----- Account rank (LCU, gray-area read) ----------------------------------
// Solo/Duo first, then Flex. Returns a tier string or null if unavailable.
async function getAccountRank(lcu) {
  try {
    const stats = await lcu.request("/lol-ranked/v1/current-ranked-stats");
    const qm = (stats && stats.queueMap) || {};
    const pick = (q) => {
      const entry = qm[q];
      return entry ? normTier(entry.tier) : null;
    };
    return pick("RANKED_SOLO_5x5") || pick("RANKED_FLEX_SR") || null;
  } catch (_) {
    return null;
  }
}

// ----- External stats API --------------------------------------------------
function fetchJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("http://") ? http : https;
    const req = lib.get(
      url,
      { timeout: timeoutMs, rejectUnauthorized: false },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function buildUrl(template, tier, role, mode) {
  return template
    .replace(/\{rank\}/gi, encodeURIComponent(String(tier || "").toLowerCase()))
    .replace(/\{role\}/gi, encodeURIComponent(String(role || "").toLowerCase()))
    .replace(/\{mode\}/gi, encodeURIComponent(String(mode || "").toLowerCase()));
}

// Query the configured API. Returns a baseline object on success (filling any
// missing fields from the table), or null on failure / unrecognized shape.
async function externalBaseline(apiUrl, tier, role, mode) {
  if (!apiUrl || typeof apiUrl !== "string") return null;
  try {
    const data = await fetchJson(buildUrl(apiUrl, tier, role, mode));
    if (!data || typeof data !== "object") return null;
    const num = (...vals) => {
      for (const v of vals) if (typeof v === "number" && isFinite(v)) return v;
      return null;
    };
    const csm = num(data.csmPerMin, data.csm, data.csPerMin);
    const kp = num(data.kp, data.killParticipation);
    const kda = num(data.kda);
    const vpm = num(data.visionPerMin, data.vpm);
    if (csm == null && kp == null && kda == null && vpm == null) return null;
    const fb = tableBaseline(tier, role);
    return {
      rank: normTier(tier) || DEFAULT_TIER,
      role: normRole(role),
      csmPerMin: csm != null ? csm : fb.csmPerMin,
      kp: kp != null ? Math.round(kp) : fb.kp,
      kda: kda != null ? kda : fb.kda,
      visionPerMin: vpm != null ? vpm : fb.visionPerMin,
      source: "live",
    };
  } catch (_) {
    return null;
  }
}

// ----- Public getter (cached) ----------------------------------------------
const cache = new Map(); // key -> { baseline, ts }
const TTL_MS = 10 * 60 * 1000;

// Resolve the baseline for a rank/role/mode. Tries the external API, then the
// baked table. Cached for TTL_MS so the 1 Hz overlay loop never spams the API.
async function getBaseline({ tier, role, mode, apiUrl } = {}) {
  const t = normTier(tier) || DEFAULT_TIER;
  const r = normRole(role);
  const key = [t, r, mode || "", apiUrl ? "live" : "table"].join("|");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.baseline;

  let baseline = await externalBaseline(apiUrl, t, r, mode);
  if (!baseline) baseline = tableBaseline(t, r);
  cache.set(key, { baseline, ts: Date.now() });
  return baseline;
}

module.exports = { getBaseline, getAccountRank, tableBaseline, DEFAULT_TIER };
