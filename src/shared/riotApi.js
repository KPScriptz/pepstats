"use strict";

// Official Riot Games API client (https://developer.riotgames.com). Lets the app
// read the player's stats from their Riot ID + region using a personal API key,
// even when the League client is closed. Compliant and read-only.
//
// Auth note: this uses the sanctioned developer API keyed by the user's own
// personal key — NOT Riot Sign-On (RSO), which is gated behind production-app
// approval. We never handle Riot account passwords.
//
// Flow: Riot ID (gameName#tagLine) --account-v1--> PUUID --summoner-v4-->
// encrypted summoner id --league-v4--> ranked entries.

const https = require("https");
const fs = require("fs");
const path = require("path");

// Platform host + regional routing cluster per selectable region.
const REGIONS = {
  NA:   { platform: "na1",  cluster: "americas", label: "North America" },
  BR:   { platform: "br1",  cluster: "americas", label: "Brazil" },
  LAN:  { platform: "la1",  cluster: "americas", label: "LAN" },
  LAS:  { platform: "la2",  cluster: "americas", label: "LAS" },
  OCE:  { platform: "oc1",  cluster: "americas", label: "Oceania" },
  KR:   { platform: "kr",   cluster: "asia",     label: "Korea" },
  JP:   { platform: "jp1",  cluster: "asia",     label: "Japan" },
  EUW:  { platform: "euw1", cluster: "europe",   label: "EU West" },
  EUNE: { platform: "eun1", cluster: "europe",   label: "EU Nordic & East" },
  TR:   { platform: "tr1",  cluster: "europe",   label: "Turkey" },
  RU:   { platform: "ru",   cluster: "europe",   label: "Russia" },
};

function regionList() {
  return Object.keys(REGIONS).map((k) => ({ code: k, label: REGIONS[k].label }));
}

function getJson(host, pathname, apiKey, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      "https://" + host + pathname,
      { timeout: timeoutMs, headers: apiKey ? { "X-Riot-Token": apiKey } : {} },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(body.replace(/^﻿/, ""))); // some CDN files have a BOM
            } catch (e) {
              reject(Object.assign(new Error("Bad JSON from Riot API"), { status: 0 }));
            }
          } else {
            reject(Object.assign(new Error("HTTP " + res.statusCode), { status: res.statusCode }));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { status: 0 })));
    req.on("error", (e) => reject(Object.assign(e, { status: e.status || 0 })));
  });
}

// Turn a Riot API error into a friendly, actionable message.
function friendly(err) {
  const s = err && err.status;
  if (s === 401 || s === 403) return "Invalid or expired API key. Grab a fresh key from developer.riotgames.com.";
  if (s === 404) return "Riot ID not found on that region. Check the spelling (Name#Tag) and region.";
  if (s === 429) return "Riot API rate limit hit — wait a minute and try again.";
  if (s === 0) return "Couldn't reach the Riot API (network/timeout).";
  return "Riot API error" + (s ? " (HTTP " + s + ")" : "") + ".";
}

function parseRiotId(riotId) {
  const raw = String(riotId || "").trim();
  const hash = raw.lastIndexOf("#");
  if (hash <= 0 || hash === raw.length - 1) return null;
  return { name: raw.slice(0, hash).trim(), tag: raw.slice(hash + 1).trim() };
}

function leagueEntry(entries, queueType) {
  const e = (entries || []).find((x) => x.queueType === queueType);
  if (!e) return null;
  return {
    tier: (e.tier || "").toUpperCase(),
    division: e.rank && e.rank !== "NA" ? e.rank : "", // league-v4 puts division in `rank`
    lp: typeof e.leaguePoints === "number" ? e.leaguePoints : 0,
    wins: e.wins || 0,
    losses: e.losses || 0,
  };
}

// Fetch the full profile (summoner + ranked) for a configured account.
// `cfg` = { riotId, region, riotApiKey }. Returns { summoner, ranked } in the
// same shape rankProgress.buildSummary expects, or throws with a friendly .message.
async function fetchProfile(cfg) {
  const key = cfg && cfg.riotApiKey;
  const id = parseRiotId(cfg && cfg.riotId);
  const reg = REGIONS[(cfg && cfg.region || "").toUpperCase()];
  if (!key) throw new Error("No Riot API key set.");
  if (!id) throw new Error("Enter your Riot ID as Name#Tag.");
  if (!reg) throw new Error("Pick a valid region.");

  let account, summoner, entries;
  try {
    account = await getJson(
      reg.cluster + ".api.riotgames.com",
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(id.name)}/${encodeURIComponent(id.tag)}`,
      key
    );
    summoner = await getJson(
      reg.platform + ".api.riotgames.com",
      `/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(account.puuid)}`,
      key
    );
    // league-v4 is queried by PUUID. Riot removed the encrypted summoner `id`
    // from summoner-v4 responses, so the old by-summoner/{id} path 403s.
    entries = await getJson(
      reg.platform + ".api.riotgames.com",
      `/lol/league/v4/entries/by-puuid/${encodeURIComponent(account.puuid)}`,
      key
    );
  } catch (err) {
    throw new Error(friendly(err));
  }

  return {
    summoner: {
      name: account.gameName || id.name,
      tagLine: account.tagLine || id.tag,
      level: summoner.summonerLevel || 0,
      profileIconId: summoner.profileIconId || 0,
      puuid: account.puuid,
    },
    ranked: {
      solo: leagueEntry(entries, "RANKED_SOLO_5x5"),
      flex: leagueEntry(entries, "RANKED_FLEX_SR"),
    },
  };
}

// ----- Match history (match-v5) --------------------------------------------
const QUEUES = {
  420: "Ranked Solo", 440: "Ranked Flex",
  400: "Normal", 430: "Normal", 490: "Normal",
  450: "ARAM", 720: "ARAM Clash",
  700: "Clash", 900: "URF", 1900: "URF", 1020: "One for All",
  1700: "Arena", 1710: "Arena", 1300: "Nexus Blitz", 1400: "Spellbook",
  830: "Co-op vs AI", 840: "Co-op vs AI", 850: "Co-op vs AI", 0: "Custom",
};
const queueLabel = (id) => QUEUES[id] || "Other";

// Dropdown filter -> match-v5 query params (queue id, or broad type).
const MATCH_FILTERS = {
  all: {},
  ranked: { queue: 420 },
  flex: { queue: 440 },
  normal: { type: "normal" },
  aram: { queue: 450 },
  arena: { queue: 1700 },
};
function filterList() {
  return [
    { key: "all", label: "All games" },
    { key: "ranked", label: "Ranked Solo/Duo" },
    { key: "flex", label: "Ranked Flex" },
    { key: "normal", label: "Normal" },
    { key: "aram", label: "ARAM" },
    { key: "arena", label: "Arena" },
  ];
}

// Data Dragon champion id differs from match `championName` for a couple champs.
const CHAMP_FIX = { FiddleSticks: "Fiddlesticks", Wukong: "MonkeyKing" };
const champKey = (name) => CHAMP_FIX[name] || name;

let _ddv = null;
async function ddragonVersion() {
  if (_ddv) return _ddv;
  try {
    const v = await getJson("ddragon.leagueoflegends.com", "/api/versions.json");
    _ddv = Array.isArray(v) && v[0] ? v[0] : "15.1.1";
  } catch (_) {
    _ddv = "15.1.1";
  }
  return _ddv;
}

// Champion index: numeric championId -> { name, id } (id = Data Dragon key for
// icon URLs). Used to turn champ-select's numeric IDs into names + portraits.
let _champIdx = null;
async function championIndex() {
  if (_champIdx) return _champIdx;
  const ver = await ddragonVersion();
  const byId = {};
  try {
    const data = await getJson("ddragon.leagueoflegends.com", `/cdn/${ver}/data/en_US/champion.json`);
    for (const key of Object.keys((data && data.data) || {})) {
      const c = data.data[key];
      if (c && c.key) byId[String(c.key)] = { name: c.name, id: c.id };
    }
  } catch (_) {}
  _champIdx = { version: ver, byId };
  return _champIdx;
}

const matchCache = new Map(); // matchId -> processed (avoids refetch on filter toggles)

// Optional cross-session persistence. main.js calls setCacheDir(userData) at
// startup; processed match details are then read from / written to disk so
// re-opening Progress in a later session doesn't re-hit the Riot API.
let _cacheFile = null;
let _cacheDirty = false;
function setCacheDir(dir) {
  if (!dir) return;
  _cacheFile = path.join(dir, "match-cache.json");
  try {
    const raw = JSON.parse(fs.readFileSync(_cacheFile, "utf8").replace(/^﻿/, ""));
    if (raw && typeof raw === "object") for (const k of Object.keys(raw)) matchCache.set(k, raw[k]);
  } catch (_) { /* no cache yet */ }
}
function clearCache() {
  matchCache.clear();
  _formCache.clear();
  _cacheDirty = false;
  try { if (_cacheFile && fs.existsSync(_cacheFile)) fs.unlinkSync(_cacheFile); } catch (_) {}
}
function saveCache() {
  if (!_cacheFile || !_cacheDirty) return;
  try {
    // Cap the on-disk cache so it can't grow unbounded (keep most recent 500).
    const entries = [...matchCache.entries()];
    const trimmed = entries.slice(Math.max(0, entries.length - 500));
    const obj = {};
    for (const [k, v] of trimmed) obj[k] = v;
    fs.writeFileSync(_cacheFile, JSON.stringify(obj));
    _cacheDirty = false;
  } catch (_) { /* non-fatal */ }
}

function keystoneOf(p) {
  const s = p.perks && p.perks.styles;
  return s && s[0] && s[0].selections && s[0].selections[0] ? s[0].selections[0].perk : null;
}
function secondaryStyleOf(p) {
  const s = p.perks && p.perks.styles;
  return s && s[1] ? s[1].style : null;
}
function pStats(p, puuid) {
  return {
    champion: p.championName,
    champKey: champKey(p.championName),
    name: p.riotIdGameName || p.summonerName || "",
    teamId: p.teamId,
    me: p.puuid === puuid,
    win: !!p.win,
    k: p.kills || 0, d: p.deaths || 0, a: p.assists || 0,
    cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
    champLevel: p.champLevel || 0,
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
    spells: [p.summoner1Id, p.summoner2Id],
    keystone: keystoneOf(p),
    dmg: p.totalDamageDealtToChampions || 0,
    gold: p.goldEarned || 0,
    vision: p.visionScore || 0,
  };
}

function processMatch(m, puuid) {
  const info = m && m.info;
  if (!info) return null;
  const parts = info.participants || [];
  const me = parts.find((p) => p.puuid === puuid);
  if (!me) return null;
  const cs = (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);
  const durSec = info.gameDuration || 0;
  const durMin = durSec / 60;
  const k = me.kills || 0, d = me.deaths || 0, a = me.assists || 0;

  const teamKills = { 100: 0, 200: 0 };
  for (const p of parts) teamKills[p.teamId] = (teamKills[p.teamId] || 0) + (p.kills || 0);
  const kp = teamKills[me.teamId] ? Math.round(((k + a) / teamKills[me.teamId]) * 100) : 0;

  return {
    id: m.metadata && m.metadata.matchId,
    queueId: info.queueId,
    queue: queueLabel(info.queueId),
    win: !!me.win,
    remake: durSec > 0 && durSec < 300,
    champion: me.championName,
    champKey: champKey(me.championName),
    champLevel: me.champLevel || 0,
    k, d, a,
    kda: d ? +(((k + a) / d).toFixed(2)) : k + a,
    cs,
    csPerMin: durMin > 0 ? +(cs / durMin).toFixed(1) : 0,
    kp, vision: me.visionScore || 0, dmg: me.totalDamageDealtToChampions || 0,
    durationSec: durSec,
    endTs: info.gameEndTimestamp || info.gameCreation || 0,
    items: [me.item0, me.item1, me.item2, me.item3, me.item4, me.item5, me.item6],
    spells: [me.summoner1Id, me.summoner2Id],
    keystone: keystoneOf(me),
    secondaryStyle: secondaryStyleOf(me),
    position: me.teamPosition || me.individualPosition || "",
    // Full lobby for the participant columns + the expandable scoreboard.
    participants: parts.map((p) => pStats(p, puuid)),
    teams: (info.teams || []).map((t) => ({
      teamId: t.teamId,
      win: !!t.win,
      baron: (t.objectives && t.objectives.baron && t.objectives.baron.kills) || 0,
      dragon: (t.objectives && t.objectives.dragon && t.objectives.dragon.kills) || 0,
      herald: (t.objectives && t.objectives.riftHerald && t.objectives.riftHerald.kills) || 0,
      grubs: (t.objectives && t.objectives.horde && t.objectives.horde.kills) || 0,
      tower: (t.objectives && t.objectives.tower && t.objectives.tower.kills) || 0,
    })),
  };
}

// Rune/style icon maps (perk id -> URL). CommunityDragon, fetched once.
function cdragonUrl(iconPath) {
  return "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/" +
    String(iconPath).replace(/^\/lol-game-data\/assets\//i, "").toLowerCase();
}
let _perkMaps = null;
async function perkMaps() {
  if (_perkMaps) return _perkMaps;
  const perks = {}, styles = {};
  const base = "/latest/plugins/rcp-be-lol-game-data/global/default/v1";
  try {
    const pj = await getJson("raw.communitydragon.org", base + "/perks.json");
    for (const p of pj || []) if (p.id && p.iconPath) perks[p.id] = cdragonUrl(p.iconPath);
  } catch (_) {}
  try {
    const sj = await getJson("raw.communitydragon.org", base + "/perkstyles.json");
    for (const s of (sj && sj.styles) || []) if (s.id && s.iconPath) styles[s.id] = cdragonUrl(s.iconPath);
  } catch (_) {}
  _perkMaps = { perks, styles };
  return _perkMaps;
}

// Fetch + process recent matches for the linked account, filtered by `filterKey`.
async function getMatches(cfg, filterKey, count = 20) {
  const key = cfg && cfg.riotApiKey;
  const id = parseRiotId(cfg && cfg.riotId);
  const reg = REGIONS[(cfg && cfg.region || "").toUpperCase()];
  if (!key || !id || !reg) throw new Error("Account not linked.");
  const host = reg.cluster + ".api.riotgames.com";

  let puuid;
  try {
    const account = await getJson(
      host,
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(id.name)}/${encodeURIComponent(id.tag)}`,
      key
    );
    puuid = account.puuid;
  } catch (err) {
    throw new Error(friendly(err));
  }

  const f = MATCH_FILTERS[filterKey] || MATCH_FILTERS.all;
  const params = ["start=0", "count=" + Math.min(50, Math.max(1, count))];
  if (f.queue) params.push("queue=" + f.queue);
  if (f.type) params.push("type=" + f.type);

  let ids = [];
  try {
    ids = await getJson(host, `/lol/match/v5/matches/by-puuid/${puuid}/ids?${params.join("&")}`, key);
  } catch (err) {
    throw new Error(friendly(err));
  }

  const out = [];
  for (const mid of ids || []) {
    if (matchCache.has(mid)) { out.push(matchCache.get(mid)); continue; }
    let m;
    try { m = await getJson(host, `/lol/match/v5/matches/${mid}`, key); } catch (_) { continue; }
    const proc = processMatch(m, puuid);
    if (proc) { matchCache.set(mid, proc); _cacheDirty = true; out.push(proc); }
  }
  saveCache(); // persist any newly fetched matches for next session
  return out;
}

// ----- Recent form for an arbitrary PUUID (champ-select ally lookup) --------
// Aggregates a player's last `count` games into win-rate + average KDA using the
// official match-v5 API. Used for teammates in champ select. The Riot ID comes
// straight out of the match participant data (riotIdGameName/#tagLine), so no
// extra account-v1 call is needed. Per-session cache keyed by puuid — champ
// select re-polls, and we must not re-hit the API for the same teammate.
const _formCache = new Map(); // puuid -> aggregated form
async function recentByPuuid(cfg, puuid, count = 5) {
  const key = cfg && cfg.riotApiKey;
  const reg = REGIONS[((cfg && cfg.region) || "").toUpperCase()];
  if (!key || !reg || !puuid) return null;
  if (_formCache.has(puuid)) return _formCache.get(puuid);

  const host = reg.cluster + ".api.riotgames.com";
  let ids = [];
  try {
    ids = await getJson(host, `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${Math.min(10, Math.max(1, count))}`, key);
  } catch (_) {
    return null; // private match history / bad key / rate limit -> no form
  }

  let games = 0, wins = 0, kS = 0, dS = 0, aS = 0, riotId = "";
  const champCount = {};
  for (const mid of ids || []) {
    let m;
    try { m = await getJson(host, `/lol/match/v5/matches/${mid}`, key); } catch (_) { continue; }
    const info = m && m.info;
    const p = (info && info.participants || []).find((x) => x.puuid === puuid);
    if (!p) continue;
    const durSec = info.gameDuration || 0;
    if (durSec > 0 && durSec < 300) continue; // skip remakes
    games++;
    if (p.win) wins++;
    kS += p.kills || 0; dS += p.deaths || 0; aS += p.assists || 0;
    if (!riotId && p.riotIdGameName) riotId = p.riotIdGameName + (p.riotIdTagLine ? "#" + p.riotIdTagLine : "");
    const ck = champKey(p.championName);
    if (ck) champCount[ck] = (champCount[ck] || 0) + 1;
  }
  const topChamp = Object.entries(champCount).sort((a, b) => b[1] - a[1])[0];
  const result = {
    games, wins,
    wr: games ? Math.round((wins / games) * 100) : null,
    kda: dS ? +(((kS + aS) / dS).toFixed(2)) : kS + aS,
    k: games ? +(kS / games).toFixed(1) : 0,
    d: games ? +(dS / games).toFixed(1) : 0,
    a: games ? +(aS / games).toFixed(1) : 0,
    riotId,
    topChamp: topChamp ? topChamp[0] : "",
  };
  _formCache.set(puuid, result);
  return result;
}

// Resolve (and cache) the account PUUID from a linked Riot ID. Needed to map a
// timeline's participantId back to the user.
const _puuidCache = {};
async function accountPuuid(cfg) {
  const key = cfg && cfg.riotApiKey;
  const id = parseRiotId(cfg && cfg.riotId);
  const reg = REGIONS[((cfg && cfg.region) || "").toUpperCase()];
  if (!key || !id || !reg) throw new Error("Account not linked.");
  const ck = (cfg.riotId || "") + "|" + (cfg.region || "");
  if (_puuidCache[ck]) return _puuidCache[ck];
  const host = reg.cluster + ".api.riotgames.com";
  const acc = await getJson(
    host,
    `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(id.name)}/${encodeURIComponent(id.tag)}`,
    key
  );
  if (acc && acc.puuid) _puuidCache[ck] = acc.puuid;
  return acc.puuid;
}

// Official Match Timeline (used to derive real skill orders). ToS-compliant.
function matchTimeline(cfg, matchId, timeoutMs = 7000) {
  const key = cfg && cfg.riotApiKey;
  const reg = REGIONS[((cfg && cfg.region) || "").toUpperCase()];
  if (!key || !reg) return Promise.reject(new Error("Account not linked."));
  const host = reg.cluster + ".api.riotgames.com";
  return getJson(host, `/lol/match/v5/matches/${matchId}/timeline`, key, timeoutMs);
}

module.exports = {
  fetchProfile, parseRiotId, regionList, REGIONS,
  getMatches, ddragonVersion, perkMaps, championIndex, filterList, queueLabel, champKey,
  setCacheDir, clearCache, getJson, accountPuuid, matchTimeline, recentByPuuid,
};
