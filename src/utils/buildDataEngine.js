"use strict";

/*
 * buildDataEngine — Riot ToS-compliant skill-order derivation.
 *
 * Derives the player's real skill-max order and full 1–15 skill path from their
 * OWN matches via Riot's official Match Timeline API
 * (GET /lol/match/v5/matches/{matchId}/timeline). No third-party scraping, no
 * bot-gated sources. Results are cached per session; on zero games / timeout /
 * API error it falls back cleanly to the curated builds.js dictionary.
 *
 * Public API:
 *   getOrDeriveSkillOrder(championName, account) ->
 *     { source:"riot"|"curated", skillMaxOrder:["Q","W","E"], skillPath:[...]|null } | null
 *   clearCache()
 */

const riotApi = require("../shared/riotApi");
const builds = require("../shared/builds");

const SLOT = { 1: "Q", 2: "W", 3: "E", 4: "R" };

// Per-session memory cache: champKey -> derived/curated result.
const cache = new Map();

// How many recent games on the champion to try before falling back.
const MAX_GAMES_TO_SCAN = 3;
const MATCH_SAMPLE = 30;       // recent matches to search for the champion
const TIMELINE_TIMEOUT_MS = 7000;

// Compute the Q/W/E max priority from an ordered skill path. Priority = which
// basic ability reaches rank 5 first; ties broken by total points, then by which
// was leveled first. R is excluded from the max order.
function deriveMaxOrder(path) {
  const stat = { Q: mk(), W: mk(), E: mk() };
  function mk() { return { count: 0, fifth: Infinity, first: Infinity }; }
  path.forEach((s, i) => {
    const st = stat[s];
    if (!st) return;
    st.count++;
    if (st.first === Infinity) st.first = i;
    if (st.count === 5 && st.fifth === Infinity) st.fifth = i;
  });
  return ["Q", "W", "E"].sort((a, b) => {
    if (stat[a].fifth !== stat[b].fifth) return stat[a].fifth - stat[b].fifth;
    if (stat[b].count !== stat[a].count) return stat[b].count - stat[a].count;
    return stat[a].first - stat[b].first;
  });
}

// Parse a Riot timeline into the user's ordered skill path. Returns null if the
// user can't be located or no skill-ups were recorded.
function parseTimeline(timeline, puuid) {
  const meta = timeline && timeline.metadata;
  const info = timeline && timeline.info;
  if (!meta || !info || !Array.isArray(meta.participants)) return null;
  const pid = meta.participants.indexOf(puuid) + 1; // participantId is 1-based
  if (pid <= 0) return null;

  const path = [];
  for (const frame of info.frames || []) {
    for (const ev of frame.events || []) {
      if (
        ev.type === "SKILL_LEVEL_UP" &&
        ev.participantId === pid &&
        SLOT[ev.skillSlot] &&
        (!ev.levelUpType || ev.levelUpType === "NORMAL") // skip Kha'Zix/Viktor EVOLVE
      ) {
        path.push(SLOT[ev.skillSlot]);
      }
    }
  }
  if (!path.length) return null;
  return { skillMaxOrder: deriveMaxOrder(path), skillPath: path.slice(0, 15) };
}

// Curated dictionary fallback (the hard offline backbone).
function curatedFallback(champKey) {
  const set = builds.getVariants(champKey);
  if (!set) return null;
  const std = set.variants[set.order[0]];
  return { source: "curated", skillMaxOrder: std.skills, skillPath: null };
}

/**
 * Resolve a champion's skill order — derived from the user's real games when
 * possible, otherwise curated. Never throws; never blocks the UI on failure.
 *
 * @param {string} championName  Display name or Data Dragon key (e.g. "Smolder").
 * @param {object} account       { riotId, region, riotApiKey } (may be incomplete).
 */
async function getOrDeriveSkillOrder(championName, account) {
  const champKey = riotApi.champKey(championName) || championName;
  if (!champKey) return null;

  // Step A — session cache.
  if (cache.has(champKey)) return cache.get(champKey);

  // No linked account → curated only.
  if (!account || !account.riotId || !account.region || !account.riotApiKey) {
    const fb = curatedFallback(champKey);
    if (fb) cache.set(champKey, fb);
    return fb;
  }

  // Step B — derive from the user's recent games on this champion.
  try {
    const puuid = await riotApi.accountPuuid(account);
    let matches = [];
    try {
      matches = await riotApi.getMatches(account, "all", MATCH_SAMPLE);
    } catch (e) {
      console.warn("[buildEngine] match list unavailable:", e.message);
    }
    const onChamp = (matches || [])
      .filter((m) => m && m.champKey === champKey && !m.remake)
      .slice(0, MAX_GAMES_TO_SCAN);

    for (const m of onChamp) {
      try {
        const tl = await riotApi.matchTimeline(account, m.id, TIMELINE_TIMEOUT_MS);
        const parsed = parseTimeline(tl, puuid);
        if (parsed && parsed.skillPath.length >= 3) {
          const result = { source: "riot", ...parsed };
          cache.set(champKey, result);
          console.log(
            `[buildEngine] ${champKey}: derived ${parsed.skillMaxOrder.join("")} from match ${m.id} (${parsed.skillPath.length} pts)`
          );
          return result;
        }
      } catch (e) {
        // 403/429/timeout/etc. — try the next game, then fall back.
        console.warn(`[buildEngine] timeline ${m.id} failed: ${e.message}`);
      }
    }
    console.log(`[buildEngine] ${champKey}: no usable timeline, using curated fallback`);
  } catch (e) {
    console.warn(`[buildEngine] derivation error for ${champKey}: ${e.message}`);
  }

  // Step C — curated fallback.
  const fb = curatedFallback(champKey);
  if (fb) cache.set(champKey, fb);
  return fb;
}

function clearCache() { cache.clear(); }

module.exports = { getOrDeriveSkillOrder, clearCache, deriveMaxOrder, parseTimeline };
