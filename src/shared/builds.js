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
  Smolder: {
    role: "BOTTOM",
    runes: { primary: 8000, sub: 8100, ids: [8008, 8009, 9101, 8017, 8139, 8135, 5008, 5008, 5001] },
    spells: [4, 7], skills: ["Q", "W", "E"],
    start: [1055, 2003], core: [3042, 6672, 3006, 3094, 3036],
  },
  Mordekaiser: {
    role: "TOP", ap: true,
    runes: { primary: 8000, sub: 8400, ids: [8010, 9111, 9104, 8299, 8444, 8453, 5005, 5008, 5001] },
    spells: [4, 6], skills: ["Q", "E", "W"],
    start: [1054, 2003], core: [4633, 3020, 3116, 3157, 3065],
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

// ---- Situational multi-build variants --------------------------------------
// Each champion has one hand-curated "Standard Core" build; the two situational
// pathways are derived from it so the offline set stays maintainable. They swap
// the final (non-boots) core item for a defensive pick and flip the defense rune
// shard, which is the highest-impact situational adjustment in practice.
const VARIANT_ORDER = ["Standard Core", "vs Heavy AP", "vs Heavy AD / Assassin"];

// Boots — never overwritten when injecting a situational item.
const BOOTS = new Set([3006, 3009, 3020, 3047, 3111, 3117, 3158, 3174, 3013]);
// Defense rune shard slot (9th perk): 5001 health · 5002 armor · 5003 magic resist.
const SHARD_HEALTH = 5001, SHARD_ARMOR = 5002, SHARD_MR = 5003;

function withSituational(base, situationalItem, defShard) {
  const core = base.core.slice();
  let idx = core.length - 1;
  while (idx > 0 && BOOTS.has(core[idx])) idx--;
  if (!core.includes(situationalItem)) core[idx] = situationalItem;
  const ids = base.runes.ids.slice();
  ids[8] = defShard;
  return { role: base.role, spells: base.spells, skills: base.skills, start: base.start, core, runes: { ...base.runes, ids } };
}

function deriveVariants(base) {
  // AP if the primary tree is Sorcery, or the entry is flagged (AP bruisers that
  // run Precision/Resolve keystones, e.g. Mordekaiser).
  const isAP = base.ap === true || base.runes.primary === 8200;
  const apCounter = isAP ? 3102 : 3156; // Banshee's Veil (mage) / Maw of Malmortius (AD)
  const adCounter = isAP ? 3157 : 3026; // Zhonya's Hourglass (mage) / Guardian Angel (AD)
  return {
    "Standard Core": base,
    "vs Heavy AP": withSituational(base, apCounter, SHARD_MR),
    "vs Heavy AD / Assassin": withSituational(base, adCounter, SHARD_ARMOR),
  };
}

// Returns { order:[names], variants:{ name: build } } or null when uncurated.
function getVariants(ddragonId) {
  const base = getBuild(ddragonId);
  if (!base) return null;
  return { order: VARIANT_ORDER.slice(), variants: deriveVariants(base) };
}

module.exports = { getBuild, getVariants, VARIANT_ORDER, BUILDS, SUMMONER_SPELLS };
