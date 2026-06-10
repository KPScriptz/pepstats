"use strict";

/*
 * tftAnalyticsEngine — deep, local TFT post-game analytics.
 *
 * Pure functions over the normalized match records produced by tftEngine
 * (placement, traits[{name,tier,units,style}], units[{name,star,cost,items[]}],
 * augments[], goldLeft, lastRound). No network, no live data — safe to run on
 * the main thread; every entry point is try/catch guarded.
 *
 * DATA LIMITS (intentionally NOT faked):
 *  - Per-round economy / interest benchmarks: NOT in the TFT MatchDto (no
 *    timeline endpoint). Only end-game gold_left + last_round are available.
 *  - Bench contents / uncombined components: NOT exposed by the API.
 *  - Portals/encounters & item-stat synergy (e.g. "AP item on AD carry"): no
 *    portal field, and synergy needs a maintained per-set dataset we don't ship.
 */

// ---- 1. Composition archetyper ---------------------------------------------
function classifyComposition(traits) {
  try {
    const active = (traits || []).filter((t) => t && t.tier > 0);
    if (!active.length) return { archetype: "Flex", primary: null, kind: "flex" };
    const byUnits = [...active].sort((a, b) => (b.units - a.units) || (b.tier - a.tier));
    const top = byUnits[0];
    if (top.units >= 6) return { archetype: `Vertical ${top.name}`, primary: top.name, kind: "vertical" };
    const second = byUnits[1];
    if (second && top.units >= 3 && second.units >= 2) {
      return { archetype: `${top.name} / ${second.name} Flex`, primary: top.name, kind: "flex2" };
    }
    return { archetype: top.name, primary: top.name, kind: "single" };
  } catch (_) {
    return { archetype: "Unknown", primary: null, kind: "unknown" };
  }
}

// ---- 2. Placement distribution ---------------------------------------------
function placementDistribution(matches) {
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  let total = 0, sum = 0, top4 = 0, wins = 0;
  try {
    for (const m of matches || []) {
      const p = m && m.placement;
      if (p >= 1 && p <= 8) { counts[p - 1]++; total++; sum += p; if (p <= 4) top4++; if (p === 1) wins++; }
    }
  } catch (_) {}
  return {
    counts, total,
    avgPlacement: total ? +(sum / total).toFixed(2) : 0,
    top4Rate: total ? Math.round((top4 / total) * 100) : 0,
    winRate: total ? Math.round((wins / total) * 100) : 0,
  };
}

// ---- 3. (removed) Augment performance matrix --------------------------------
// Riot's TFT policy prohibits displaying augment win rates and augment average
// placements — even computed from the player's own matches. Removed in 0.6.0.

// ---- 4. Per-composition trends ---------------------------------------------
function compTrends(matches) {
  const map = new Map();
  try {
    for (const m of matches || []) {
      if (!(m.placement >= 1 && m.placement <= 8)) continue;
      const arc = classifyComposition(m.traits).archetype;
      const e = map.get(arc) || { archetype: arc, games: 0, sum: 0, top4: 0 };
      e.games++; e.sum += m.placement; if (m.placement <= 4) e.top4++;
      map.set(arc, e);
    }
  } catch (_) {}
  return [...map.values()]
    .map((e) => ({ archetype: e.archetype, games: e.games, avgPlacement: +(e.sum / e.games).toFixed(2), top4Rate: Math.round((e.top4 / e.games) * 100) }))
    .sort((a, b) => b.games - a.games || a.avgPlacement - b.avgPlacement);
}

// ---- 5. Economy audit (end-game only — see DATA LIMITS) ---------------------
function auditEconomy(m) {
  try {
    const gold = (m && m.goldLeft) || 0;
    let note = "Spent your gold down before dying — good resource use.";
    if (gold >= 30) note = "Died holding 30+ gold — roll or level sooner to convert it into board strength.";
    else if (gold >= 15) note = "Left some gold unspent at death.";
    return { goldLeft: gold, lastRound: (m && m.lastRound) || 0, flag: gold >= 30 ? "warn" : gold >= 15 ? "note" : "ok", note };
  } catch (_) {
    return { goldLeft: 0, lastRound: 0, flag: "ok", note: "" };
  }
}

// ---- 6. Carry itemization check --------------------------------------------
function carryItemization(m) {
  try {
    const units = (m && m.units) || [];
    if (!units.length) return null;
    const carry = [...units].sort((a, b) => (b.cost - a.cost) || (b.star - a.star))[0];
    const items = (carry.items || []).length;
    return {
      carry: carry.name, cost: carry.cost, star: carry.star, items, complete: items >= 3,
      flag: items >= 3 ? "ok" : "warn",
      note: items >= 3
        ? `${carry.name} was fully itemized (${items} items).`
        : `${carry.name} carried only ${items} item${items === 1 ? "" : "s"} — aim for 3 completed items on your main carry.`,
    };
  } catch (_) {
    return null;
  }
}

// ---- Top-level bundle for the dashboard ------------------------------------
function analyze(matches) {
  try {
    matches = Array.isArray(matches) ? matches : [];
    const perMatch = matches.map((m) => {
      const cls = classifyComposition(m.traits);
      return {
        id: m.id,
        placement: m.placement,
        top4: m.placement >= 1 && m.placement <= 4,
        archetype: cls.archetype,
        archetypeKind: cls.kind,
        economy: auditEconomy(m),
        carry: carryItemization(m),
      };
    });
    return {
      ok: true,
      distribution: placementDistribution(matches),
      comps: compTrends(matches),
      perMatch,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  classifyComposition, placementDistribution,
  compTrends, auditEconomy, carryItemization, analyze,
};
