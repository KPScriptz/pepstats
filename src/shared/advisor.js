"use strict";

// Free, offline advice engine. Generates climb advice, champion picks and a
// post-match tactical review from data PepStats already pulls for free over the
// internet (Riot API match history + ranked status, Data Dragon champion data) —
// no paid LLM tokens, no API key, fully private. Output is Markdown that the
// home/post-game renderers turn into formatted HTML.
//
// The advice is heuristic: it reads the player's real numbers (win rate, LP
// trend, CS/min, KDA, kill-timeline clustering) and a small bundled, curated
// meta tier list, then maps them to concrete, high-value coaching points.

// --- Bundled curated meta picks per role (reliable, easy-to-climb champions).
// Hand-maintained; expand freely. Kept short on purpose.
const META = {
  TOP: ["Garen", "Darius", "Sett", "Malphite", "Mordekaiser"],
  JUNGLE: ["Warwick", "Vi", "Jarvan IV", "Nunu & Willump", "Master Yi"],
  MIDDLE: ["Annie", "Lux", "Ahri", "Veigar", "Malzahar"],
  BOTTOM: ["Caitlyn", "Jinx", "Miss Fortune", "Ashe", "Sivir"],
  UTILITY: ["Lulu", "Soraka", "Leona", "Nautilus", "Janna"],
};
const ROLE_LABEL = {
  TOP: "top", JUNGLE: "jungle", MIDDLE: "mid", BOTTOM: "bot lane", UTILITY: "support",
};

function fmtPoints(points) {
  // points: array of { title, body } -> numbered bold Markdown block.
  return points
    .slice(0, 4)
    .map((p, i) => `**${i + 1}. ${p.title}**\n${p.body}`)
    .join("\n\n");
}

// ---- 1. Climb advice (exactly 4 points, no timeline) -----------------------
function climbAdvice(summary) {
  const prog = (summary && summary.progress) || {};
  const solo = (summary && summary.solo) || {};
  const wk = (summary && summary.weekly) || {};
  const wr = typeof prog.winRate === "number" ? prog.winRate : null;
  const games = (prog.wins || 0) + (prog.losses || 0);
  const lp = typeof solo.lp === "number" ? solo.lp : null;
  const trend = typeof wk.gain === "number" ? wk.gain : null;
  const rank = prog.label || "your current rank";
  const next = prog.next || "the next division";

  const pool = [];

  // Win-rate driven core point.
  if (wr != null && wr < 45) {
    pool.push({
      title: "Tighten the fundamentals before chasing plays",
      body: `At a ${wr}% win rate the fastest gains come from cutting deaths, not forcing highlights. Play for clean, low-risk leads: last-hit through the wave, respect the enemy jungler, and only fight when you have a clear advantage.`,
    });
  } else if (wr != null && wr <= 52) {
    pool.push({
      title: "Convert even games into wins",
      body: `Your ${wr}% win rate says games are close — the tiebreaker is mistakes. Focus on one decision per game you usually get wrong (a bad recall, a greedy fight) and consciously fix it. Consistency climbs faster than flashy peaks.`,
    });
  } else if (wr != null) {
    pool.push({
      title: "You're winning — so play more, deliberately",
      body: `A ${wr}% win rate means volume is your friend. Queue more games while the form holds, but keep reviewing losses so the rate doesn't slip as you push toward ${next}.`,
    });
  } else {
    pool.push({
      title: "Build a sample to climb on",
      body: `Play a handful of ranked games so your win rate stabilizes — then target the one habit that's costing you the most. Early on, consistency beats experimentation.`,
    });
  }

  // LP-trend driven point.
  if (trend != null && trend < 0) {
    pool.push({
      title: "Set a daily stop-loss",
      body: `Your LP is down ${Math.abs(trend)} over the last week — that's usually tilt compounding, not skill. After two losses in a row, stop for the day. Protecting LP you already have is as valuable as gaining new LP.`,
    });
  } else if (trend != null && trend > 0) {
    pool.push({
      title: "Ride the momentum",
      body: `You're up ${trend} LP this week. Keep the exact champion pool and playstyle that earned it — don't experiment with off-role or new picks while the climb is working.`,
    });
  } else {
    pool.push({
      title: "Stick to a small champion pool",
      body: `Pick two or three champions and queue them every game. Mastery of a tight pool removes a huge source of variance and lets you focus on the map instead of your own mechanics.`,
    });
  }

  // LP-position nuance.
  if (lp != null && lp >= 75) {
    pool.push({
      title: "Play safe into your promotion",
      body: `You're at ${lp} LP and close to ${next}. Favor your most comfortable pick and a low-risk game plan — getting to the promo on a champion you trust beats a coin-flip blind pick.`,
    });
  } else {
    pool.push({
      title: "Win the early game, then group",
      body: `Get a lead in the first 10 minutes, then look to translate it into objectives with your team. Most games at ${rank} are decided by who turns small leads into dragons, heralds and towers — not by farming forever.`,
    });
  }

  // Evergreen high-value points to guarantee four strong items.
  pool.push({
    title: "Review one death every game",
    body: `Before requeueing, open the last game and ask why your worst death happened — caught warding, overextended, no vision. Spotting the pattern is how you stop repeating it.`,
  });
  pool.push({
    title: "Ward on a timer, not a vibe",
    body: `Drop a ward every time it's off cooldown and refresh river control before objectives spawn. Vision is the cheapest win rate you can buy, and most players at ${rank} skip it under pressure.`,
  });

  return fmtPoints(pool);
}

// ---- 2. Champion picks ------------------------------------------------------
// champStats: [{ champion, g, w, k, d, a }] aggregated from recent matches.
function champPicks(rank, role, champStats) {
  champStats = Array.isArray(champStats) ? champStats : [];
  const roleKey = META[role] ? role : null;
  const roleName = ROLE_LABEL[role] || "your role";

  // Rank the player's own champions: enough games, weighted by win rate then KDA.
  const scored = champStats
    .filter((c) => c.g >= 2)
    .map((c) => {
      const wr = Math.round((c.w / c.g) * 100);
      const kda = c.d ? (c.k + c.a) / c.d : c.k + c.a;
      return { name: c.champion, g: c.g, wr, kda: +kda.toFixed(1), score: wr + Math.min(kda, 6) * 4 };
    })
    .sort((a, b) => b.score - a.score);

  const lines = [];
  const picks = [];

  for (const c of scored.slice(0, 3)) {
    if (c.wr >= 50 || c.kda >= 2.5) {
      picks.push(c.name);
      lines.push(`**${c.name}** — your strongest pick lately (${c.wr}% WR, ${c.kda} KDA over ${c.g} games). Keep spamming it; comfort wins games.`);
    }
  }

  // Fill from the bundled meta for the player's role, skipping ones already listed.
  if (roleKey) {
    for (const m of META[roleKey]) {
      if (picks.length >= 4) break;
      if (picks.includes(m)) continue;
      picks.push(m);
      lines.push(`**${m}** — a reliable, easy-to-pilot ${roleName} pick that climbs well and forgives mistakes.`);
    }
  }

  if (!lines.length) {
    // No role detected and no history: give a safe, role-agnostic starter set.
    for (const m of ["Garen", "Annie", "Caitlyn", "Lux"]) {
      picks.push(m);
      lines.push(`**${m}** — simple, strong, and great for locking in fundamentals while you climb.`);
    }
  }

  const focus = [
    "Master two or three of these rather than playing all of them — depth beats breadth on the ladder.",
    "Pick for the team comp: if you're missing engage or front-line, choose the champion that fills the gap.",
    "Track your win rate per champion here in Progress and cut anyone who consistently underperforms.",
  ];

  return [
    `Best champions to climb with at ${rank || "your rank"}${roleKey ? ` (${roleName})` : ""}:`,
    "",
    ...lines.map((l) => "- " + l),
    "",
    "**What to focus on**",
    ...focus.map((f) => "- " + f),
  ].join("\n");
}

// ---- 3. Post-match tactical review (exactly 3 takeaways) --------------------
// snapshot: { champion, gameTime(sec), kda:{k,d,a}, cs, csPerMin, gold, events:[] }
function matchReview(snapshot) {
  const s = snapshot || {};
  const min = s.gameTime ? Math.max(1, Math.round(s.gameTime / 60)) : null;
  const cpm = typeof s.csPerMin === "number" ? s.csPerMin : (s.cs && min ? s.cs / min : null);
  const k = (s.kda && s.kda.k) || 0;
  const d = (s.kda && s.kda.d) || 0;
  const a = (s.kda && s.kda.a) || 0;
  const kda = d ? ((k + a) / d) : (k + a);

  // Kill-event timeline clustering (proxy for skirmish vs. objective play).
  const killTimes = (s.events || [])
    .filter((e) => e.EventName === "ChampionKill" && typeof e.EventTime === "number")
    .map((e) => e.EventTime)
    .sort((x, y) => x - y);
  let clusters = 0;
  for (let i = 0; i < killTimes.length; i++) {
    if (i === 0 || killTimes[i] - killTimes[i - 1] > 25) clusters++;
  }

  const points = [];

  // 1. Farming / economy.
  if (cpm != null) {
    if (cpm < 5) {
      points.push({
        title: "Farm is leaking gold",
        body: `${cpm.toFixed(1)} CS/min is below curve — missed minions are missed items.\n_Fix:_ after every recall or fight, get back to a wave and last-hit the next three camps or minions before roaming.`,
      });
    } else if (cpm < 7) {
      points.push({
        title: "Solid farm, push it higher",
        body: `${cpm.toFixed(1)} CS/min is decent but there's a power spike on the table.\n_Fix:_ catch the side wave between objectives instead of standing in river with nothing to do.`,
      });
    } else {
      points.push({
        title: "Strong farming — now spend it",
        body: `${cpm.toFixed(1)} CS/min is excellent.\n_Fix:_ make sure that gold turns into map pressure — recall on a full back and use your item spikes to force objectives.`,
      });
    }
  } else {
    points.push({
      title: "Track your CS per minute",
      body: `Farm data wasn't captured this game.\n_Fix:_ aim for 7+ CS/min as a laner; it's the simplest lever on your gold lead.`,
    });
  }

  // 2. Deaths / risk.
  if (d >= 8) {
    points.push({
      title: "Too many deaths",
      body: `${d} deaths hands the enemy gold and map control even in a good game.\n_Fix:_ before each fight, check your minimap for the enemy jungler and a clear escape — if either is missing, don't commit.`,
    });
  } else if (kda < 2 && d > 0) {
    points.push({
      title: "Trade more efficiently",
      body: `A ${kda.toFixed(1)} KDA means your fights are roughly break-even.\n_Fix:_ only take fights you can win on cooldowns and numbers — walk away from 50/50s and let your team collapse with you.`,
    });
  } else {
    points.push({
      title: "Clean fighting — keep it up",
      body: `A ${typeof kda === "number" ? kda.toFixed(1) : kda} KDA shows good fight selection.\n_Fix:_ now press the advantage faster — convert won fights into towers and objectives instead of resetting.`,
    });
  }

  // 3. Objective / tempo (from kill clustering).
  if (clusters >= 4) {
    points.push({
      title: "Pathing looks reactive",
      body: `Your game had several separate fight clusters — a sign of chasing skirmishes rather than playing for objectives.\n_Fix:_ after each kill or fight, ask "what objective does this unlock?" and walk toward dragon, herald or a tower instead of the next fight.`,
    });
  } else {
    points.push({
      title: "Play around objective timers",
      body: `Anchor your recalls and tempo to dragon and herald spawns, not just to fights.\n_Fix:_ back with enough gold to be on the map and ahead in items 60–90 seconds before each major objective.`,
    });
  }

  return points
    .slice(0, 3)
    .map((p, i) => `**${i + 1}. ${p.title}**\n${p.body}`)
    .join("\n\n");
}

module.exports = { climbAdvice, champPicks, matchReview, META };
