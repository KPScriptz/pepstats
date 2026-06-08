"use strict";

// Curated draft-coach data + engine (offline, no external data source).
//
// IMPORTANT: Riot publishes no champion matchup / tier / win-rate API, and
// scraping OP.GG / U.GG is off-limits. So this is a HAND-CURATED table — honest,
// bundled meta knowledge — NOT live win-rates. Expand the tables below; keys are
// Data Dragon champion ids (e.g. "Malphite"), matching builds.js + championIndex.
//
// COUNTERS[x]  = champions that tend to beat x (suggest when an ENEMY locks x).
// SYNERGIES[x] = champions that pair well with x (suggest when an ALLY locks x).
// REASONS gives a short, human "why" shown next to a suggestion.

const COUNTERS = {
  Yasuo: ["Malphite", "Annie", "Pantheon", "Renekton"],
  Yone: ["Malphite", "Pantheon", "Renekton"],
  Zed: ["Malphite", "Lissandra", "Kayle", "Diana"],
  Katarina: ["Diana", "Galio", "Lissandra"],
  Darius: ["Vayne", "Quinn", "Kayle", "Gnar"],
  Garen: ["Vayne", "Quinn", "Kayle"],
  Mordekaiser: ["Vayne", "Quinn", "Fiora"],
  Malphite: ["Vayne", "Gnar", "Kennen"],
  Lux: ["Yasuo", "Zed", "Kassadin", "Talon"],
  Ahri: ["Kassadin", "Talon", "Fizz"],
  Jinx: ["Caitlyn", "Draven", "Nilah"],
  Caitlyn: ["Nilah", "Samira", "Lucian"],
  Ashe: ["Caitlyn", "Draven", "Kaisa"],
  MissFortune: ["Caitlyn", "Draven"],
  Vayne: ["Caitlyn", "Draven", "Ashe"],
  Smolder: ["Draven", "Caitlyn"],
  Vi: ["Nocturne", "Master Yi"],
  Neeko: ["Kassadin", "Talon", "Zed"],
};

const SYNERGIES = {
  Yasuo: ["Malphite", "Diana", "Gragas", "Alistar", "Wukong"],
  Yone: ["Malphite", "Diana", "Orianna", "Gragas"],
  Orianna: ["Malphite", "Wukong", "Yasuo", "Diana"],
  Malphite: ["Yasuo", "Yone", "Orianna", "Katarina"],
  MissFortune: ["Leona", "Nautilus", "Amumu"],
  Jinx: ["Thresh", "Lulu", "Milio"],
  Caitlyn: ["Lux", "Morgana", "Karma"],
  Ashe: ["Thresh", "Leona"],
  Smolder: ["Lulu", "Milio", "Janna"],
  Vayne: ["Lulu", "Janna", "Nami"],
  Diana: ["Yasuo", "Yone", "Orianna"],
  Vi: ["Orianna", "Yasuo", "MissFortune"],
  Garen: ["Lux", "Katarina"],
  Neeko: ["Yasuo", "Wukong", "Malphite"],
};

const REASONS = {
  Malphite: "AoE knock-up engage",
  Diana: "AoE knock-up + dive",
  Wukong: "knock-up engage",
  Gragas: "displacement engage",
  Alistar: "double-CC engage",
  Orianna: "shockwave follow-up",
  Leona: "lock-down engage",
  Nautilus: "point-and-click CC",
  Amumu: "AoE stun wombo",
  Thresh: "hook + peel",
  Lulu: "hypercarry peel",
  Milio: "range + cleanse peel",
  Janna: "disengage + peel",
  Nami: "sustain + CC peel",
  Morgana: "spell shield + bind",
  Karma: "poke + shield",
  Lux: "poke + binding root",
  Vayne: "shreds tanks",
  Quinn: "ranged lane bully",
  Kayle: "scales + ranged poke",
  Caitlyn: "longest lane range",
  Draven: "lane-bully damage",
  Nilah: "melee-carry all-in",
  Samira: "all-in burst",
  Lucian: "early all-in",
  Kaisa: "burst + reposition",
  Kassadin: "magic-shield assassin",
  Talon: "roam + burst",
  Fizz: "evasive dive",
  Zed: "burst assassin",
  Annie: "point-and-click stun",
  Pantheon: "early all-in + block",
  Renekton: "early lane bully",
  Lissandra: "self-peel + CC",
  Galio: "anti-AP bulk",
  Fiora: "true-damage duelist",
  Gnar: "ranged + mega CC",
  Kennen: "ranged poke",
  Nocturne: "fear pick",
  "Master Yi": "punishes immobility",
};

const reasonFor = (key) => REASONS[key] || "strong pick";

// Build a ranked suggestion list from a lookup table for a set of "trigger"
// champions, scoring by how many triggers each suggestion answers. Excludes
// anything already on either team or hovered by the user.
function rank(table, triggers, taken) {
  const score = {};
  for (const t of triggers) {
    for (const s of table[t] || []) {
      if (taken.has(s)) continue;
      score[s] = score[s] || { key: s, count: 0, vs: [] };
      score[s].count++;
      score[s].vs.push(t);
    }
  }
  return Object.values(score)
    .sort((a, b) => b.count - a.count)
    .map((s) => ({ key: s.key, reason: reasonFor(s.key), vs: s.vs }));
}

/**
 * advise({ allyKeys, enemyKeys, takenKeys }) ->
 *   { counters: [{key, reason, vs:[enemyKey]}], synergies: [{key, reason, vs:[allyKey]}] }
 * All inputs/outputs are Data Dragon champion keys. `takenKeys` (everything
 * already picked/banned/hovered) is filtered out of the suggestions.
 */
function advise({ allyKeys = [], enemyKeys = [], takenKeys = [] } = {}) {
  const taken = new Set([...takenKeys, ...allyKeys, ...enemyKeys]);
  return {
    counters: rank(COUNTERS, enemyKeys.filter(Boolean), taken).slice(0, 3),
    synergies: rank(SYNERGIES, allyKeys.filter(Boolean), taken).slice(0, 3),
  };
}

module.exports = { advise, COUNTERS, SYNERGIES, reasonFor };
