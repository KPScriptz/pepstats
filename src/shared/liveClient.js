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

function activeScores(data) {
  const players = (data && data.allPlayers) || [];
  const activeName =
    (data && data.activePlayer && data.activePlayer.summonerName) || "";
  const me =
    players.find((p) => {
      const riotId =
        p.riotIdGameName && p.riotIdTagLine
          ? p.riotIdGameName + "#" + p.riotIdTagLine
          : p.summonerName;
      return riotId === activeName || p.summonerName === activeName;
    }) || players[0];

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

// Lane-opponent comparison from the sanctioned allPlayers feed. The Live Client
// publishes every player's champion/level/KDA/CS/position, so comparing against
// the same-role enemy is compliant. The lone exception is gold: only the active
// player's gold is exposed, so GPM is your value only (no opponent number).
function compareStats(data) {
  const players = (data && data.allPlayers) || [];
  const gameTime = (data && data.gameData && data.gameData.gameTime) || 0;
  const minutes = gameTime / 60;
  const activeName =
    (data && data.activePlayer && data.activePlayer.summonerName) || "";

  const me =
    players.find((p) => {
      const riotId =
        p.riotIdGameName && p.riotIdTagLine
          ? p.riotIdGameName + "#" + p.riotIdTagLine
          : p.summonerName;
      return riotId === activeName || p.summonerName === activeName;
    }) ||
    players[0] ||
    null;

  const gold = (data && data.activePlayer && data.activePlayer.currentGold) || 0;
  const result = {
    hasOpp: false,
    role: (me && me.position) || "",
    csmYou: 0,
    csmDiff: null,
    gpm: minutes > 0 ? gold / minutes : 0,
    kp: { you: 0, opp: null },
    kda: { you: 0, opp: null },
    lvl: { you: 0, opp: null },
    vision: { you: 0, opp: null },
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

  const opp = me.position
    ? players.find((p) => p.team !== me.team && p.position === me.position)
    : null;
  if (opp) {
    result.hasOpp = true;
    const osc = opp.scores || {};
    const oppCsm = minutes > 0 ? (osc.creepScore || 0) / minutes : 0;
    result.csmDiff = result.csmYou - oppCsm;
    result.lvl.opp = opp.level || 0;
    result.kda.opp = kdaRatio(osc);
    result.vision.opp = osc.wardScore != null ? Math.round(osc.wardScore) : 0;
    const oTK = teamKills(players, opp.team);
    result.kp.opp =
      oTK > 0
        ? Math.round((((osc.kills || 0) + (osc.assists || 0)) / oTK) * 100)
        : 0;
  }
  return result;
}

module.exports = { getAllGameData, activeScores, compareStats };
