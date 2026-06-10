"use strict";

/*
 * lcuHistory — keyless match history through the League client itself.
 *
 * The LCU exposes the logged-in player's own LoL and TFT match history locally
 * (read-only GETs on the lockfile port). That means a fresh install works out
 * of the box with just the client open — no Riot API key required. A linked
 * key remains the richer source (full 10-player lobbies, KP%, damage share,
 * works with the client closed); these mappers mark their rows `partial` so
 * the UI degrades honestly instead of inventing numbers.
 *
 * Compliance: same sanctioned local LCU surface the rest of the app reads —
 * the player's OWN data only. Brawl (queue 480) stays excluded per policy.
 */

const lcu = require("./lcu");
const riotApi = require("./riotApi");
const tftEngine = require("../utils/tftEngine");

async function ownPuuid() {
  const me = await lcu.request("/lol-summoner/v1/current-summoner");
  if (!me || !me.puuid) throw new Error("client");
  return me.puuid;
}

// LCU timeline lane/role -> our position labels (best effort; blank off-SR).
function positionOf(tl) {
  const lane = String((tl && tl.lane) || "").toUpperCase();
  const role = String((tl && tl.role) || "").toUpperCase();
  if (lane === "JUNGLE") return "JUNGLE";
  if (lane === "TOP") return "TOP";
  if (lane === "MIDDLE" || lane === "MID") return "MIDDLE";
  if (lane === "BOTTOM" || lane === "BOT") return role.includes("SUPPORT") ? "UTILITY" : "BOTTOM";
  return "";
}

// One LCU game -> the same row shape riotApi.processMatch emits, minus the
// fields the local payload genuinely lacks (kp, dmgShare, the full lobby).
function mapLolGame(g, idx) {
  if (!g || g.queueId === 480) return null; // Brawl excluded everywhere (policy)
  const part = (g.participants && g.participants[0]) || null;
  const s = (part && part.stats) || null;
  if (!part || !s) return null;
  const durSec = g.gameDuration || 0;
  const durMin = durSec / 60;
  const k = s.kills || 0, d = s.deaths || 0, a = s.assists || 0;
  const cs = (s.totalMinionsKilled || 0) + (s.neutralMinionsKilled || 0);
  const ci = idx && idx.byId ? idx.byId[String(part.championId)] : null;
  return {
    id: String(g.gameId || ""),
    queueId: g.queueId,
    queue: riotApi.queueLabel(g.queueId),
    win: !!s.win,
    remake: durSec > 0 && durSec < 300,
    champion: ci ? ci.name : "Champion",
    champKey: ci ? ci.id : "",
    champLevel: s.champLevel || 0,
    k, d, a,
    kda: d ? +(((k + a) / d).toFixed(2)) : k + a,
    cs,
    csPerMin: durMin > 0 ? +(cs / durMin).toFixed(1) : 0,
    kp: null,        // needs the full lobby (Riot key path)
    vision: s.visionScore || 0,
    dmg: s.totalDamageDealtToChampions || 0,
    dmgShare: null,  // needs team damage (Riot key path)
    durationSec: durSec,
    endTs: (g.gameCreation || 0) + durSec * 1000,
    items: [s.item0, s.item1, s.item2, s.item3, s.item4, s.item5, s.item6],
    spells: [part.spell1Id, part.spell2Id],
    keystone: s.perk0 || null,
    secondaryStyle: s.perkSubStyle || null,
    position: positionOf(part.timeline),
    participants: [], // local history carries only the player's own slot
    teams: [],
    partial: true,
    source: "lcu",
  };
}

// The player's recent LoL games via the client. Returns the same array shape
// as riotApi.getMatches (rows marked partial).
async function lolMatches(count = 20) {
  const puuid = await ownPuuid();
  const end = Math.min(40, Math.max(1, count));
  const res = await lcu.request(
    `/lol-match-history/v1/products/lol/${encodeURIComponent(puuid)}/matches?begIndex=0&endIndex=${end}`
  );
  const games = (res && res.games && res.games.games) || [];
  let idx = null;
  try { idx = await riotApi.championIndex(); } catch (_) {}
  return games
    .slice()
    .sort((x, y) => (y.gameCreation || 0) - (x.gameCreation || 0))
    .map((g) => mapLolGame(g, idx))
    .filter(Boolean);
}

// The player's recent TFT games via the client, normalized through the same
// tftEngine.parseParticipant the Riot-key path uses.
async function tftMatches(count = 20) {
  const puuid = await ownPuuid();
  const n = Math.min(20, Math.max(1, count));
  const res = await lcu.request(
    `/lol-match-history/v1/products/tft/${encodeURIComponent(puuid)}/matches?begin=0&count=${n}`
  );
  const games = (res && res.games) || [];
  const out = [];
  for (const g of games) {
    const info = (g && (g.json || g)) || null;
    if (!info || !Array.isArray(info.participants)) continue;
    const me = info.participants.find((p) => p && p.puuid === puuid);
    if (!me) continue;
    const rec = tftEngine.parseParticipant(me);
    rec.id = (info.metadata && info.metadata.match_id) || String(info.gameId || info.game_id || "");
    rec.queueId = info.queue_id || info.queueId || 0;
    rec.queue = info.queue_id === 1100 || info.queueId === 1100 ? "Ranked TFT" : "TFT";
    rec.set = (info.tft_set_core_name && String(info.tft_set_core_name).replace(/\D/g, "")) || info.tft_set_number || "";
    rec.length = Math.round(info.game_length || info.gameLength || 0);
    rec.endTs = info.game_datetime || info.gameCreation || 0;
    rec.source = "lcu";
    out.push(rec);
  }
  return out;
}

// Ranked TFT entry via the client (current-ranked-stats carries RANKED_TFT).
async function tftRankLcu() {
  const r = await lcu.request("/lol-ranked/v1/current-ranked-stats");
  const e = r && r.queueMap && r.queueMap.RANKED_TFT;
  if (!e || !e.tier || String(e.tier).toUpperCase() === "NONE") return { ranked: false };
  return {
    ranked: true,
    tier: String(e.tier).toUpperCase(),
    division: e.division && e.division !== "NA" ? e.division : "",
    lp: typeof e.leaguePoints === "number" ? e.leaguePoints : 0,
    wins: e.wins || 0,
    losses: e.losses || 0,
  };
}

module.exports = { lolMatches, tftMatches, tftRankLcu };
