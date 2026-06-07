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
      { timeout: timeoutMs, headers: { "X-Riot-Token": apiKey } },
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
    entries = await getJson(
      reg.platform + ".api.riotgames.com",
      `/lol/league/v4/entries/by-summoner/${encodeURIComponent(summoner.id)}`,
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

module.exports = { fetchProfile, parseRiotId, regionList, REGIONS };
