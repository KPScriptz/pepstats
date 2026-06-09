"use strict";

/*
 * liveCombatEngine — live combat threat matrix (read-only, sanctioned).
 *
 * Reads ONLY Riot's Live Client Data API (127.0.0.1:2999). It reformats info
 * the player can already see on the Tab scoreboard (enemy KDA / CS / completed
 * items) into a threat ranking. No memory reads, no automation.
 *
 * Deliberately NOT included: real-time counter-item "buy X now" prescriptions.
 * Surfacing enemy items is factual/visible; prescribing your build mid-match is
 * the kind of live prescription Riot's policy discourages — that advice belongs
 * in champ-select / post-game. We expose factual enemy-resistance data only.
 *
 *   start() / stop() / get() -> latest threat snapshot
 */

const liveClient = require("../shared/liveClient");

const FAST_MS = 3000;
const SLOW_MS = 6000;

// Notable defensive items, by Live Client displayName, for a FACTUAL resistance
// readout (not a prescription).
const MR_ITEMS = new Set(["Force of Nature", "Kaenic Rookern", "Spirit Visage", "Maw of Malmortius", "Mercurial Scimitar", "Wit's End", "Banshee's Veil", "Adaptive Helm"]);
const ARMOR_ITEMS = new Set(["Thornmail", "Frozen Heart", "Randuin's Omen", "Plated Steelcaps", "Guardian Angel", "Dead Man's Plate", "Sunfire Aegis"]);

let timer = null;
let interval = FAST_MS;
let latest = { available: false };

function reschedule(next) {
  if (next === interval) return;
  interval = next;
  if (timer) { clearInterval(timer); timer = setInterval(tick, interval); }
}

// Threat = (K*2) + (A*1) + (CS/10) - (D*1.5). Highest = priority target.
function calculateThreatIndices(data) {
  const me = liveClient.findMe(data);
  const players = (data && data.allPlayers) || [];
  if (!me) return { available: false };
  const enemies = players.filter((p) => p.team !== me.team);
  if (!enemies.length) return { available: false };

  let enemyMR = 0, enemyArmor = 0;
  const threats = enemies.map((p) => {
    const s = p.scores || {};
    const k = s.kills || 0, d = s.deaths || 0, a = s.assists || 0, cs = s.creepScore || 0;
    const items = (p.items || []).map((it) => it.displayName).filter(Boolean);
    items.forEach((n) => { if (MR_ITEMS.has(n)) enemyMR++; if (ARMOR_ITEMS.has(n)) enemyArmor++; });
    return {
      champion: p.championName || "",
      name: p.riotIdGameName || p.summonerName || "",
      position: p.position || "",
      k, d, a, cs,
      threat: +((k * 2) + (a * 1) + (cs / 10) - (d * 1.5)).toFixed(1),
      fed: (k - d) >= 3,
      items,
    };
  }).sort((x, y) => y.threat - x.threat);

  const top = threats[0];
  return {
    available: true,
    threats,
    priority: top ? { champion: top.champion, name: top.name, threat: top.threat, line: `${top.k}/${top.d}/${top.a}`, fed: top.fed } : null,
    // Factual resistance readout for the UI (no prescription).
    enemyResist: { mr: enemyMR, armor: enemyArmor },
  };
}

async function tick() {
  try {
    const data = await liveClient.getAllGameData(2500);
    latest = calculateThreatIndices(data) || { available: false };
    reschedule(FAST_MS);
  } catch (_) {
    latest = { available: false };
    reschedule(SLOW_MS);
  }
}

function start() { if (timer) return; interval = FAST_MS; timer = setInterval(tick, interval); tick(); }
function stop() { if (timer) { clearInterval(timer); timer = null; } interval = FAST_MS; latest = { available: false }; }
function get() { return latest; }

module.exports = { start, stop, get, calculateThreatIndices };
