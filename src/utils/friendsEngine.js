"use strict";

/*
 * friendsEngine — Vanguard-compliant friends tracking.
 *
 * Reads ONLY:
 *  - the local LCU API (lol-chat friends + presence) via the client lockfile, and
 *  - the official Riot Match API (by-puuid ids + timeline) with the user's key.
 * No memory reading, no injection, no screen scraping, no third-party scraping.
 *
 * Public API:
 *   getFriends()                      -> { ok, friends:[...], version } | { ok:false, error }
 *   friendDigest(puuid, account)      -> { matchId, entries:[...] } | null
 */

const lcu = require("../shared/lcu");
const riotApi = require("../shared/riotApi");
const { SUMMONER_SPELLS } = require("../shared/builds");

const DD = "https://ddragon.leagueoflegends.com/cdn";

// Status display order (most "interesting" first).
const ORDER = { ingame: 0, champselect: 1, inqueue: 2, online: 3, away: 4, mobile: 5, offline: 6 };

// Normalize one raw LCU friend record into the shape the UI consumes.
function normalize(f, idx) {
  if (!f || !f.puuid) return null;
  const av = String(f.availability || "").toLowerCase();
  const lol = f.lol || {};
  const gs = String(lol.gameStatus || "").toLowerCase();

  let status = "online", label = "Online";
  if (!av || av === "offline") { status = "offline"; label = "Offline"; }
  else if (av === "mobile") { status = "mobile"; label = "Mobile"; }
  else if (gs === "ingame") { status = "ingame"; label = "In Game"; }
  else if (gs === "championselect") { status = "champselect"; label = "Champ Select"; }
  else if (gs === "inqueue") { status = "inqueue"; label = "In Queue"; }
  else if (av === "away") { status = "away"; label = "Away"; }

  const champId = Number(lol.championId) || 0;
  const ci = champId && idx && idx.byId ? idx.byId[champId] : null;
  const queueId = Number(lol.queueId) || 0;
  const queue = lol.gameQueueType || (queueId ? riotApi.queueLabel(queueId) : "");

  return {
    puuid: f.puuid,
    name: f.gameName || f.name || "Summoner",
    tag: f.gameTag || "",
    status, label,
    championId: champId,
    champName: ci ? ci.name : "",
    champKey: ci ? ci.id : "",
    queue,
    since: Number(lol.timeStamp) || 0, // ms epoch the current state began
    iconId: Number(f.icon) || 0,
  };
}

// Track status transitions so the UI can flag a friend who just finished a game.
const _prevStatus = new Map();
function detectTransitions(friends) {
  for (const f of friends) {
    const prev = _prevStatus.get(f.puuid);
    if (prev === "ingame" && f.status !== "ingame") f.justFinished = true;
    _prevStatus.set(f.puuid, f.status);
  }
}

async function getFriends() {
  let raw;
  try {
    raw = await lcu.request("/lol-chat/v1/friends");
  } catch (e) {
    return { ok: false, error: "client" }; // League client not running
  }
  if (!Array.isArray(raw)) return { ok: true, friends: [] };

  let idx = { byId: {}, version: null };
  try { idx = await riotApi.championIndex(); } catch (_) {}

  const friends = raw.map((f) => normalize(f, idx)).filter(Boolean);
  friends.sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || a.name.localeCompare(b.name));
  detectTransitions(friends);
  return { ok: true, friends, version: idx.version };
}

// ---- Recent-match timeline digest for a friend (official Riot API) ----------
const SLOT = { 1: "Q", 2: "W", 3: "E", 4: "R" };
const MONSTER = { DRAGON: "Dragon", RIFTHERALD: "Rift Herald", BARON_NASHOR: "Baron", HORDE: "Void Grubs", ELDER_DRAGON: "Elder Dragon" };
const fmt = (sec) => Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");

function buildDigest(tl, puuid) {
  const meta = tl && tl.metadata, info = tl && tl.info;
  if (!meta || !info || !Array.isArray(meta.participants)) return { entries: [] };
  const pid = meta.participants.indexOf(puuid) + 1;
  if (pid <= 0) return { entries: [] };
  const team100 = pid <= 5;
  const mates = team100 ? [1, 2, 3, 4, 5] : [6, 7, 8, 9, 10];

  const entries = [];
  const skillCount = { Q: 0, W: 0, E: 0 };
  let firstBloodSeen = false, kills = 0;

  for (const frame of info.frames || []) {
    for (const ev of frame.events || []) {
      const t = Math.floor((ev.timestamp || 0) / 1000);
      if (ev.type === "CHAMPION_KILL") {
        if (!firstBloodSeen) {
          firstBloodSeen = true;
          entries.push({ t, kind: ev.killerId === pid ? "fb-you" : "fb", text: ev.killerId === pid ? "First Blood (yours)" : "First Blood" });
        }
        if (ev.killerId === pid && kills < 4) { kills++; entries.push({ t, kind: "kill", text: "Kill" }); }
      } else if (ev.type === "ELITE_MONSTER_KILL" && mates.includes(ev.killerId)) {
        entries.push({ t, kind: "obj", text: "Secured " + (MONSTER[ev.monsterType] || "Objective") });
      } else if (
        ev.type === "SKILL_LEVEL_UP" && ev.participantId === pid &&
        SLOT[ev.skillSlot] && SLOT[ev.skillSlot] !== "R" &&
        (!ev.levelUpType || ev.levelUpType === "NORMAL")
      ) {
        const ab = SLOT[ev.skillSlot];
        if (++skillCount[ab] === 5) entries.push({ t, kind: "skill", text: ab + " maxed" });
      }
    }
  }
  entries.sort((a, b) => a.t - b.t);
  return { entries: entries.slice(0, 8).map((e) => ({ ...e, time: fmt(e.t) })) };
}

async function friendDigest(puuid, account) {
  try {
    if (!puuid || !account || !account.riotApiKey || !account.region) return null;
    const reg = riotApi.REGIONS[String(account.region).toUpperCase()];
    if (!reg) return null;
    const host = reg.cluster + ".api.riotgames.com";
    const ids = await riotApi.getJson(host, `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=1`, account.riotApiKey, 7000);
    const mid = ids && ids[0];
    if (!mid) return { matchId: null, entries: [] };
    const tl = await riotApi.matchTimeline(account, mid, 8000);
    return { matchId: mid, ...buildDigest(tl, puuid) };
  } catch (e) {
    console.warn("[friendsEngine] digest failed:", e.message);
    return null;
  }
}

// ---- Premium profile: rank + recent form + top mastery (official API) -------
// Win-rate / matches come from the RANKED season entry (league-v4); K/D from the
// recent-form aggregate. All official, read-only, by the friend's PUUID.
async function friendProfile(puuid, account) {
  if (!puuid || !account || !account.riotApiKey || !account.region) return null;
  let idx = { byId: {}, version: null };
  try { idx = await riotApi.championIndex(); } catch (_) {}
  const ver = idx.version;
  const champ = (id) => (idx.byId && idx.byId[id]) ? idx.byId[id] : null;

  const [rank, recent, mastery] = await Promise.all([
    riotApi.rankByPuuid(account, puuid).catch(() => null),
    riotApi.recentByPuuid(account, puuid, 10).catch(() => null),
    riotApi.masteryTop(account, puuid, 3).catch(() => []),
  ]);

  const solo = rank && rank.solo;
  const wins = solo ? solo.wins : 0, losses = solo ? solo.losses : 0, games = wins + losses;
  return {
    rank: solo ? { tier: solo.tier, division: solo.division, lp: solo.lp, wins, losses } : null,
    winRate: games ? Math.round((wins / games) * 100) : (recent ? recent.wr : null),
    matches: games || (recent ? recent.games : 0),
    kda: recent ? recent.kda : null,
    mastery: (mastery || []).map((m) => {
      const c = champ(m.championId);
      return {
        name: c ? c.name : "Champion",
        icon: ver && c ? `${DD}/${ver}/img/champion/${c.id}.png` : null,
        level: m.championLevel || 0,
        points: m.championPoints || 0,
      };
    }),
    version: ver,
  };
}

// ---- Live spectate: DRAFT ONLY (Spectator API) ------------------------------
// Both teams' champions, summoner spells and bans. The spectator API exposes NO
// live items / gold / KDA / events, so this is intentionally a draft board, not
// a real-time ticker. { ok, inGame, blue:[...], red:[...], bans:[...] }.
async function friendLiveGame(puuid, account) {
  try {
    if (!puuid || !account || !account.riotApiKey || !account.region) return { ok: false, error: "link" };
    const game = await riotApi.spectatorByPuuid(account, puuid);
    if (!game) return { ok: true, inGame: false };

    let idx = { byId: {}, version: null };
    try { idx = await riotApi.championIndex(); } catch (_) {}
    const ver = idx.version;
    const champ = (id) => (idx.byId && idx.byId[id]) ? idx.byId[id] : null;
    const cIcon = (id) => { const c = champ(id); return ver && c ? `${DD}/${ver}/img/champion/${c.id}.png` : null; };
    const sIcon = (id) => (ver && SUMMONER_SPELLS[id]) ? `${DD}/${ver}/img/spell/${SUMMONER_SPELLS[id]}.png` : null;

    const team = (tid) => (game.participants || [])
      .filter((p) => p.teamId === tid)
      .map((p) => ({
        isFriend: p.puuid === puuid,
        champion: (champ(p.championId) || {}).name || "",
        championIcon: cIcon(p.championId),
        spells: [sIcon(p.spell1Id), sIcon(p.spell2Id)],
        name: p.riotId || p.summonerName || "",
      }));

    return {
      ok: true,
      inGame: true,
      queue: riotApi.queueLabel(game.gameQueueConfigId),
      gameLength: game.gameLength || 0,
      blue: team(100),
      red: team(200),
      bans: (game.bannedChampions || []).filter((b) => b.championId > 0).map((b) => ({ icon: cIcon(b.championId), teamId: b.teamId })),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { getFriends, friendDigest, buildDigest, friendProfile, friendLiveGame };
