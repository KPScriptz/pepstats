"use strict";

// Curated, bundled champion builds (offline — no external data source).
// A hand-picked starter set; expand by adding entries keyed by the champion's
// Data Dragon id. Rune ids are stable across patches; item ids can drift, so the
// UI tolerates a missing icon. `runes.ids` is in LCU rune-page order so it can be
// imported directly: [keystone, primary1, primary2, primary3, secondary1,
// secondary2, shard1, shard2, shard3].
//
// Style ids: Precision 8000 · Domination 8100 · Sorcery 8200 · Resolve 8400 · Inspiration 8300
// Common shards: 5008 adaptive · 5005 atk-speed · 5007 ability-haste · 5001 health-scaling

const BUILDS = {
  Jinx: {
    role: "BOTTOM",
    runes: { primary: 8000, sub: 8100, ids: [8008, 8009, 9101, 8017, 8139, 8135, 5008, 5008, 5001] },
    spells: [4, 7], skills: ["Q", "W", "E"],
    start: [1055, 2003], core: [6672, 3031, 3006, 6673, 3036],
  },
  Caitlyn: {
    role: "BOTTOM",
    runes: { primary: 8000, sub: 8100, ids: [8005, 8009, 9101, 8014, 8139, 8135, 5008, 5008, 5001] },
    spells: [4, 7], skills: ["Q", "W", "E"],
    start: [1055, 2003], core: [6672, 3031, 3006, 6675, 3036],
  },
  Ashe: {
    role: "BOTTOM",
    runes: { primary: 8000, sub: 8100, ids: [8005, 8009, 9101, 8014, 8135, 8105, 5008, 5008, 5001] },
    spells: [4, 7], skills: ["Q", "W", "E"],
    start: [1055, 2003], core: [6672, 3094, 3006, 3031, 3036],
  },
  MissFortune: {
    role: "BOTTOM",
    runes: { primary: 8000, sub: 8100, ids: [8008, 8009, 9101, 8017, 8139, 8135, 5008, 5008, 5001] },
    spells: [4, 7], skills: ["Q", "E", "W"],
    start: [1055, 2003], core: [3508, 6676, 3006, 3031, 3036],
  },
  Vayne: {
    role: "BOTTOM",
    runes: { primary: 8000, sub: 8100, ids: [8008, 8009, 9101, 8014, 8139, 8135, 5008, 5008, 5001] },
    spells: [4, 7], skills: ["Q", "W", "E"],
    start: [1055, 2003], core: [6672, 3006, 3091, 3031, 3036],
  },
  Lux: {
    role: "MIDDLE",
    runes: { primary: 8200, sub: 8300, ids: [8229, 8226, 8210, 8237, 8345, 8347, 5007, 5008, 5001] },
    spells: [4, 14], skills: ["Q", "E", "W"],
    start: [1056, 2003], core: [6655, 3020, 3157, 3089, 3135],
  },
  Vi: {
    role: "JUNGLE",
    runes: { primary: 8000, sub: 8400, ids: [8010, 9111, 9104, 8299, 8444, 8451, 5005, 5008, 5001] },
    spells: [4, 11], skills: ["Q", "E", "W"],
    start: [1101, 2003], core: [3071, 3047, 3053, 3074, 3742],
  },
  Garen: {
    role: "TOP",
    runes: { primary: 8000, sub: 8400, ids: [8010, 9111, 9104, 8299, 8444, 8451, 5005, 5008, 5001] },
    spells: [4, 12], skills: ["Q", "E", "W"],
    start: [1054, 2003], core: [6333, 3047, 3071, 3053, 3742],
  },
  Neeko: {
    role: "MIDDLE",
    runes: { primary: 8200, sub: 8100, ids: [8214, 8226, 8210, 8237, 8139, 8135, 5007, 5008, 5001] },
    spells: [4, 14], skills: ["Q", "E", "W"],
    start: [1056, 2003], core: [6655, 3020, 3157, 3089, 3135],
  },
};

const SUMMONER_SPELLS = {
  1: "SummonerBoost", 3: "SummonerExhaust", 4: "SummonerFlash", 6: "SummonerHaste",
  7: "SummonerHeal", 11: "SummonerSmite", 12: "SummonerTeleport", 13: "SummonerMana",
  14: "SummonerDot", 21: "SummonerBarrier", 32: "SummonerSnowball",
};

function getBuild(ddragonId) {
  return (ddragonId && BUILDS[ddragonId]) || null;
}

module.exports = { getBuild, BUILDS, SUMMONER_SPELLS };
