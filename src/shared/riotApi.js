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
              resolve(JSON.parse(body));
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

const matchCache = new Map(); // matchId -> processed (avoids refetch on filter toggles)

function processMatch(m, puuid) {
  const info = m && m.info;
  if (!info) return null;
  const me = (info.participants || []).find((p) => p.puuid === puuid);
  if (!me) return null;
  const cs = (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);
  const durSec = info.gameDuration || 0;
  const durMin = durSec / 60;
  const k = me.kills || 0, d = me.deaths || 0, a = me.assists || 0;
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
    durationSec: durSec,
    endTs: info.gameEndTimestamp || info.gameCreation || 0,
    items: [me.item0, me.item1, me.item2, me.item3, me.item4, me.item5, me.item6],
    spells: [me.summoner1Id, me.summoner2Id],
    position: me.teamPosition || me.individualPosition || "",
    // The full lobby (two teams of 5) for the op.gg-style participant columns.
    participants: (info.participants || []).map((p) => ({
      champKey: champKey(p.championName),
      name: p.riotIdGameName || p.summonerName || "",
      teamId: p.teamId,
      me: p.puuid === puuid,
    })),
  };
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
    if (proc) { matchCache.set(mid, proc); out.push(proc); }
  }
  return out;
}

module.exports = {
  fetchProfile, parseRiotId, regionList, REGIONS,
  getMatches, ddragonVersion, filterList, queueLabel, champKey,
};
