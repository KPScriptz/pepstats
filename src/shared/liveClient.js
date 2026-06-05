"use strict";

// Riot-sanctioned in-game data. Only serves data while a match is live
// (incl. Practice Tool / customs). Self-signed cert -> rejectUnauthorized:false.
const https = require("https");
const http = require("http");

const DEFAULT_BASE = "https://127.0.0.1:2999/liveclientdata";

// PEPSTATS_LIVE_BASE lets the local mock simulator point this at a plain-http
// loopback server. Production never sets it, so the default is unchanged.
function liveBase() {
  return process.env.PEPSTATS_LIVE_BASE || DEFAULT_BASE;
}

function getJson(pathname, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const url = liveBase() + pathname;
    const isHttps = url.startsWith("https:");
    const mod = isHttps ? https : http;
    const opts = { timeout: timeoutMs };
    if (isHttps) opts.rejectUnauthorized = false; // Riot's self-signed loopback cert
    const req = mod.get(
      url,
      opts,
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

module.exports = { getAllGameData, activeScores };
