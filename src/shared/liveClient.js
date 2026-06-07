"use strict";

// Riot-sanctioned in-game data. Only serves data while a match is live
// (incl. Practice Tool / customs). Self-signed cert -> rejectUnauthorized:false.
const https = require("https");

const BASE = "https://127.0.0.1:2999/liveclientdata";

function getJson(pathname, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      BASE + pathname,
      { rejectUnauthorized: false, timeout: timeoutMs },
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

const getAllGameData = (timeoutMs) => getJson("/allgamedata", timeoutMs);

// Find the active (local) player in the allPlayers feed. Matches on Riot ID or
// legacy summoner name, falling back to the first player.
function findMe(data) {
  const players = (data && data.allPlayers) || [];
  const activeName =
    (data && data.activePlayer && data.activePlayer.summonerName) || "";
  return (
    players.find((p) => {
      const riotId =
        p.riotIdGameName && p.riotIdTagLine
          ? p.riotIdGameName + "#" + p.riotIdTagLine
          : p.summonerName;
      return riotId === activeName || p.summonerName === activeName;
    }) ||
    players[0] ||
    null
  );
}

// Mode/map identification. The neutral epic objectives (grubs/herald/dragon/
// baron) exist only on Summoner's Rift (CLASSIC, map 11); everything else
// (ARAM=12, Arena, URF, …) has no jungle, so callers suppress those timers.
function gameInfo(data) {
  const gd = (data && data.gameData) || {};
  const gameMode = gd.gameMode || "";
  const mapNumber = typeof gd.mapNumber === "number" ? gd.mapNumber : null;
  const isClassic = gameMode === "CLASSIC" || mapNumber === 11;
  return { gameMode, mapNumber, isClassic };
}

// The active player's assigned position ("TOP"/"JUNGLE"/… or "" off-SR). Used
// to pick the right rank baseline before building the comparison.
function activeRole(data) {
  const me = findMe(data);
  return (me && me.position) || "";
}

function activeScores(data) {
  const me = findMe(data);
  const gameTime = (data && data.gameData && data.gameData.gameTime) || 0;
  const minutes = gameTime / 60;
  const cs = (me && me.scores && me.scores.creepScore) || 0;

  return {
    gameTime,
    cs,
    csPerMin: minutes > 0 ? cs / minutes : 0,
    gold: (data && data.activePlayer && data.activePlayer.currentGold) || 0,
    kda: me && me.scores
      ? { k: me.scores.kills, d: me.scores.deaths, a: me.scores.assists }
      : { k: 0, d: 0, a: 0 },
    champion: (me && me.championName) || "",
    events: (data && data.events && data.events.Events) || [],
  };
}

function kdaRatio(sc) {
  const k = (sc && sc.kills) || 0;
  const d = (sc && sc.deaths) || 0;
  const a = (sc && sc.assists) || 0;
  return d > 0 ? (k + a) / d : k + a;
}

function teamKills(players, team) {
  return players
    .filter((p) => p.team === team)
    .reduce((s, p) => s + ((p.scores && p.scores.kills) || 0), 0);
}

// Compares the active player against a rank baseline (you vs the average player
// at your rank), not a lane opponent. This is the right reference in every mode
// — ARAM and other no-lane modes have no role opponent to compare against, and
// even on the Rift it answers "how am I doing for my elo?" rather than "vs this
// one enemy". `baseline` is a rankBaseline object (or null to omit comparison).
// Gold is still your value only (the feed exposes no other player's gold).
function compareStats(data, baseline) {
  const players = (data && data.allPlayers) || [];
  const gameTime = (data && data.gameData && data.gameData.gameTime) || 0;
  const minutes = gameTime / 60;
  const me = findMe(data);

  const gold = (data && data.activePlayer && data.activePlayer.currentGold) || 0;
  const result = {
    role: (me && me.position) || "",
    rank: (baseline && baseline.rank) || null,
    baselineSource: (baseline && baseline.source) || null,
    csmYou: 0,
    csmBaseline: null,
    csmDiff: null,
    gpm: minutes > 0 ? gold / minutes : 0,
    kp: { you: 0, baseline: null },
    kda: { you: 0, baseline: null },
    lvl: { you: 0 },
    vision: { you: 0, baseline: null },
  };
  if (!me) return result;

  const sc = me.scores || {};
  result.csmYou = minutes > 0 ? (sc.creepScore || 0) / minutes : 0;
  result.lvl.you = me.level || 0;
  result.kda.you = kdaRatio(sc);
  result.vision.you = sc.wardScore != null ? Math.round(sc.wardScore) : 0;
  const myTK = teamKills(players, me.team);
  result.kp.you =
    myTK > 0 ? Math.round((((sc.kills || 0) + (sc.assists || 0)) / myTK) * 100) : 0;

  if (baseline) {
    result.csmBaseline = baseline.csmPerMin;
    result.csmDiff = result.csmYou - baseline.csmPerMin;
    result.kp.baseline = baseline.kp;
    result.kda.baseline = baseline.kda;
    // Vision is reported cumulatively, so scale the per-minute baseline to the
    // current game time for an apples-to-apples comparison.
    result.vision.baseline = Math.round((baseline.visionPerMin || 0) * minutes);
  }
  return result;
}

module.exports = {
  getAllGameData,
  activeScores,
  compareStats,
  gameInfo,
  activeRole,
};
