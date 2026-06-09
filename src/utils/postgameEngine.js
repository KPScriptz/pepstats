"use strict";

/*
 * postgameEngine — tactical post-game analytics from the player's latest match.
 *
 * Vanguard-compliant: uses only the official Riot Match API (match detail +
 * timeline) keyed by the user's PUUID. The timeline's per-minute
 * participantFrames expose currentGold (unspent gold), which powers a real Gold
 * Spending Efficiency curve — no fabricated differential.
 *
 *   analyze(account) -> { ok, matchId, version, summary, gse, objectives, skill, compare } | { ok:false }
 */

const riotApi = require("../shared/riotApi");
const builds = require("../shared/builds");
const { deriveMaxOrder } = require("./buildDataEngine");

const SLOT = { 1: "Q", 2: "W", 3: "E", 4: "R" };
const MONSTER = { DRAGON: "Dragon", RIFTHERALD: "Rift Herald", BARON_NASHOR: "Baron", HORDE: "Void Grubs", ELDER_DRAGON: "Elder Dragon" };
const GSE_WARN = 1500; // unspent gold at a dragon = flagged missed spike

function host(account) {
  const reg = riotApi.REGIONS[String(account.region || "").toUpperCase()];
  return reg ? reg.cluster + ".api.riotgames.com" : null;
}

function summaryFrom(detail, puuid) {
  const info = detail && detail.info;
  const me = info && (info.participants || []).find((p) => p.puuid === puuid);
  if (!me) return null;
  const cs = (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);
  const durSec = info.gameDuration || 0;
  const durMin = durSec / 60 || 1;
  return {
    champion: me.championName,
    champKey: me.championName,
    win: !!me.win,
    k: me.kills || 0, d: me.deaths || 0, a: me.assists || 0,
    kda: me.deaths ? +(((me.kills + me.assists) / me.deaths).toFixed(2)) : me.kills + me.assists,
    cs, csPerMin: +(cs / durMin).toFixed(1),
    gold: me.goldEarned || 0,
    durationSec: durSec,
    level: me.champLevel || 0,
    position: me.teamPosition || me.individualPosition || "",
  };
}

// Gold Spending Efficiency series + objective markers + over-cap warnings.
function gseFrom(timeline, puuid) {
  const meta = timeline && timeline.metadata, info = timeline && timeline.info;
  if (!meta || !info) return { gse: [], objectives: [] };
  const pid = meta.participants.indexOf(puuid) + 1;
  if (pid <= 0) return { gse: [], objectives: [] };
  const team100 = pid <= 5;

  const gse = [];
  for (const frame of info.frames || []) {
    const pf = frame.participantFrames && frame.participantFrames[String(pid)];
    if (!pf) continue;
    gse.push({ t: Math.floor((frame.timestamp || 0) / 1000), gold: pf.currentGold || 0 });
  }
  const goldAt = (sec) => {
    let g = 0;
    for (const p of gse) { if (p.t <= sec) g = p.gold; else break; }
    return g;
  };

  const objectives = [];
  for (const frame of info.frames || []) {
    for (const ev of frame.events || []) {
      if (ev.type !== "ELITE_MONSTER_KILL") continue;
      const t = Math.floor((ev.timestamp || 0) / 1000);
      const byMyTeam = (ev.killerId <= 5) === team100;
      const isDragon = ev.monsterType === "DRAGON" || ev.monsterType === "ELDER_DRAGON";
      objectives.push({
        t, type: ev.monsterType, label: MONSTER[ev.monsterType] || "Objective",
        byMyTeam,
        warn: isDragon && goldAt(t) > GSE_WARN,
        goldAt: goldAt(t),
      });
    }
  }
  return { gse, objectives };
}

function skillFrom(timeline, puuid, champKey) {
  const meta = timeline && timeline.metadata, info = timeline && timeline.info;
  if (!meta || !info) return null;
  const pid = meta.participants.indexOf(puuid) + 1;
  if (pid <= 0) return null;
  const path = [];
  for (const frame of info.frames || []) {
    for (const ev of frame.events || []) {
      if (ev.type === "SKILL_LEVEL_UP" && ev.participantId === pid && SLOT[ev.skillSlot] &&
        (!ev.levelUpType || ev.levelUpType === "NORMAL")) path.push(SLOT[ev.skillSlot]);
    }
  }
  if (!path.length) return null;
  const actual = deriveMaxOrder(path);
  const set = builds.getVariants(champKey);
  const curated = set ? set.variants[set.order[0]].skills : null;
  let note = "";
  if (curated) {
    note = actual.join("") === curated.join("")
      ? `Matches the curated max path (${actual.join(" › ")}).`
      : `You maxed ${actual[0]} first; curated path prioritizes ${curated[0]} (${curated.join(" › ")}).`;
  }
  return { path: path.slice(0, 15), actual, curated, note };
}

async function analyze(account) {
  try {
    if (!account || !account.riotApiKey || !account.region || !account.riotId) return { ok: false, error: "Link your account first." };
    const h = host(account);
    if (!h) return { ok: false, error: "Unknown region." };
    const puuid = await riotApi.accountPuuid(account);
    const ids = await riotApi.getJson(h, `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=1`, account.riotApiKey, 7000);
    const matchId = ids && ids[0];
    if (!matchId) return { ok: false, error: "No recent match found." };

    const detail = await riotApi.getJson(h, `/lol/match/v5/matches/${matchId}`, account.riotApiKey, 8000);
    const summary = summaryFrom(detail, puuid);
    let timeline = null;
    try { timeline = await riotApi.matchTimeline(account, matchId, 8000); } catch (_) {}

    const { gse, objectives } = timeline ? gseFrom(timeline, puuid) : { gse: [], objectives: [] };
    const skill = timeline && summary ? skillFrom(timeline, puuid, summary.champKey) : null;

    // Historical comparison on this champion (this match excluded).
    let compare = null;
    if (summary) {
      try {
        const matches = await riotApi.getMatches(account, "all", 30);
        const past = (matches || []).filter((m) => m.champKey === summary.champKey && m.id !== matchId && !m.remake);
        if (past.length) {
          const avg = (sel) => +(past.reduce((s, m) => s + sel(m), 0) / past.length).toFixed(1);
          compare = {
            games: past.length,
            kda: { now: summary.kda, avg: avg((m) => m.kda) },
            csPerMin: { now: summary.csPerMin, avg: avg((m) => m.csPerMin) },
          };
        }
      } catch (_) {}
    }

    const version = await riotApi.ddragonVersion();
    return { ok: true, matchId, version, summary, gse, objectives, skill, compare };
  } catch (e) {
    console.warn("[postgameEngine] analyze failed:", e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { analyze };
