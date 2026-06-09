"use strict";

/*
 * tftEngine — Teamfight Tactics match-history adapter.
 *
 * Vanguard-compliant & policy-compliant: post-game ONLY, via the official
 * /tft/match/v1/ endpoints routed through the regional CLUSTER (americas /
 * europe / asia). No live prescriptions, no in-game overlays, no third parties.
 *
 *   getMatches(account, count) ->
 *     { ok:true, matches:[...] } | { ok:false, error:"tft-access"|"link"|... }
 *
 * NOTE: parser is written against Riot's documented TFT MatchDto schema. It is
 * compile-verified; live verification is pending TFT-Match-V1 access on the key
 * (every call currently 403s until that product is enabled).
 */

const riotApi = require("../shared/riotApi");

const _cache = new Map(); // matchId -> parsed record (per session)

// TFT rarity index -> champion cost. (Riot uses 0,1,2,4,6 historically; map
// defensively and fall back to rarity+1.)
const COST_BY_RARITY = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 4, 5: 5, 6: 5 };

const QUEUE = { 1090: "Normal", 1100: "Ranked", 1110: "Tutorial", 1130: "Hyper Roll", 1160: "Double Up", 1170: "Double Up" };

function clusterHost(region) {
  const r = riotApi.REGIONS[String(region || "").toUpperCase()];
  return r ? r.cluster + ".api.riotgames.com" : null;
}

// "TFT13_Ambessa" -> "Ambessa"; "TFT_Item_InfinityEdge" -> "Infinity Edge".
function cleanName(id) {
  return String(id || "")
    .replace(/^TFT\d*_?/, "")
    .replace(/^(Item|Augment)_?/, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

function parseParticipant(p) {
  return {
    placement: p.placement || 0,
    level: p.level || 0,
    goldLeft: p.gold_left || 0,
    lastRound: p.last_round || 0,
    players_eliminated: p.players_eliminated || 0,
    traits: (p.traits || [])
      .filter((t) => t.tier_current > 0)
      .map((t) => ({ name: cleanName(t.name), tier: t.tier_current, units: t.num_units || 0, style: t.style || t.tier_current }))
      .sort((a, b) => b.tier - a.tier || b.units - a.units),
    units: (p.units || [])
      .map((u) => ({
        id: u.character_id,
        name: cleanName(u.character_id),
        star: u.tier || 1,
        cost: COST_BY_RARITY[u.rarity] != null ? COST_BY_RARITY[u.rarity] : (u.rarity || 0) + 1,
        items: (u.itemNames || []).map(cleanName),
      }))
      .sort((a, b) => b.cost - a.cost || b.star - a.star),
    augments: (p.augments || []).map(cleanName),
    companion: p.companion ? { contentId: p.companion.content_ID, skinId: p.companion.skin_ID, species: p.companion.species } : null,
  };
}

async function getMatches(account, count = 10) {
  if (!account || !account.riotApiKey || !account.region || !account.riotId) return { ok: false, error: "link" };
  const host = clusterHost(account.region);
  if (!host) return { ok: false, error: "region" };

  try {
    const puuid = await riotApi.accountPuuid(account);
    let ids;
    try {
      ids = await riotApi.getJson(host, `/tft/match/v1/matches/by-puuid/${puuid}/ids?start=0&count=${Math.min(20, Math.max(1, count))}`, account.riotApiKey, 8000);
    } catch (e) {
      if (e.status === 403) return { ok: false, error: "tft-access" };
      throw e;
    }
    if (!Array.isArray(ids)) return { ok: true, matches: [] };

    const out = [];
    for (const id of ids) {
      if (_cache.has(id)) { out.push(_cache.get(id)); continue; }
      let m;
      try { m = await riotApi.getJson(host, `/tft/match/v1/matches/${id}`, account.riotApiKey, 9000); } catch (_) { continue; }
      const info = m && m.info;
      if (!info) continue;
      const me = (info.participants || []).find((x) => x.puuid === puuid);
      if (!me) continue;
      const rec = {
        id,
        queueId: info.queue_id,
        queue: QUEUE[info.queue_id] || "TFT",
        set: info.tft_set_number,
        setCore: info.tft_set_core_name,
        length: Math.round(info.game_length || 0),
        endTs: info.game_datetime || 0,
        ...parseParticipant(me),
      };
      _cache.set(id, rec);
      out.push(rec);
    }
    return { ok: true, matches: out };
  } catch (e) {
    if (e.status === 403) return { ok: false, error: "tft-access" };
    return { ok: false, error: e.message };
  }
}

function clearCache() { _cache.clear(); }

module.exports = { getMatches, parseParticipant, cleanName, clearCache };
