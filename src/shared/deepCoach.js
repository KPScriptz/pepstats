"use strict";

/*
 * deepCoach — post-game macro review from YOUR OWN match timeline.
 *
 * Pulls the user's most recent match via the official match-v5 API, fetches its
 * Match Timeline, and for each of the user's deaths reconstructs the 60 seconds
 * of context before it: gold/level/CS then vs now, the killer's gold lead, and
 * how much map action (kills / objectives) happened in that window. This is the
 * only place per-player gold-over-time legally exists — it's the user's own
 * completed match from Riot's sanctioned API, not live or enemy-hidden data.
 *
 * Returns a Markdown payload string for the AI coach, or null when unavailable
 * (account not linked, match not yet indexed, no deaths, API error) so the
 * caller can fall back to the lightweight snapshot payload.
 */

const riotApi = require("./riotApi");

const WINDOW_MS = 60000;   // look-back window before each death
const MAX_DEATHS = 6;      // cap the payload size

const clock = (ms) => {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

// Participant state from the latest timeline frame at/just-before `ts`.
function frameAt(frames, pid, ts) {
  let chosen = null;
  for (const f of frames) {
    if (f.timestamp <= ts) chosen = f;
    else break;
  }
  if (!chosen) chosen = frames[0];
  const pf = chosen && chosen.participantFrames && chosen.participantFrames[String(pid)];
  if (!pf) return null;
  return {
    gold: pf.totalGold || 0,
    level: pf.level || 0,
    cs: (pf.minionsKilled || 0) + (pf.jungleMinionsKilled || 0),
  };
}

// Count champion kills + neutral/structure objectives in [t0, t1].
function actionInWindow(frames, t0, t1) {
  let kills = 0, objectives = 0;
  for (const f of frames) {
    for (const ev of f.events || []) {
      if (ev.timestamp < t0 || ev.timestamp > t1) continue;
      if (ev.type === "CHAMPION_KILL") kills++;
      else if (ev.type === "ELITE_MONSTER_KILL" || ev.type === "BUILDING_KILL") objectives++;
    }
  }
  return { kills, objectives };
}

const signed = (n) => (n >= 0 ? "+" : "−") + Math.abs(n);

async function buildTimelineReview(account) {
  if (!account || !account.riotId || !account.region || !account.riotApiKey) return null;

  let puuid, matches;
  try {
    puuid = await riotApi.accountPuuid(account);
    matches = await riotApi.getMatches(account, "all", 1);
  } catch (_) {
    return null;
  }
  const game = matches && matches[0];
  if (!game || !game.id) return null;

  let tl;
  try {
    tl = await riotApi.matchTimeline(account, game.id);
  } catch (_) {
    return null; // match not indexed yet (post-game delay) or API error
  }
  const meta = tl && tl.metadata;
  const info = tl && tl.info;
  if (!meta || !info || !Array.isArray(meta.participants)) return null;
  const pid = meta.participants.indexOf(puuid) + 1; // participantId is 1-based
  if (pid <= 0) return null;

  const frames = info.frames || [];
  const champOf = (participantId) =>
    (participantId > 0 && game.participants && game.participants[participantId - 1] && game.participants[participantId - 1].champion) || "an enemy";

  const deaths = [];
  for (const f of frames) {
    for (const ev of f.events || []) {
      if (ev.type === "CHAMPION_KILL" && ev.victimId === pid) deaths.push(ev);
    }
  }
  if (!deaths.length) return null;

  const lines = [
    "# Death-by-death macro context (my own match)",
    `- Champion: ${game.champion} · Result: ${game.win ? "Win" : "Loss"} · Duration: ${Math.round((game.durationSec || 0) / 60)} min · Final KDA ${game.k}/${game.d}/${game.a}`,
    `- Deaths reconstructed below: ${Math.min(deaths.length, MAX_DEATHS)} of ${deaths.length}`,
    "",
  ];

  deaths.slice(0, MAX_DEATHS).forEach((d, i) => {
    const ts = d.timestamp;
    const now = frameAt(frames, pid, ts);
    const before = frameAt(frames, pid, Math.max(0, ts - WINDOW_MS));
    const killer = d.killerId ? frameAt(frames, d.killerId, ts) : null;
    const act = actionInWindow(frames, Math.max(0, ts - WINDOW_MS), ts);

    lines.push(`## Death ${i + 1} — ${clock(ts)}, killed by ${champOf(d.killerId)}`);
    if (now) lines.push(`- At death: ${now.gold}g, level ${now.level}, ${now.cs} CS`);
    if (now && before) {
      lines.push(`- 60s earlier: ${before.gold}g, level ${before.level}, ${before.cs} CS (${signed(now.gold - before.gold)}g, ${signed(now.cs - before.cs)} CS in that minute)`);
    }
    if (killer && now) {
      const diff = killer.gold - now.gold;
      lines.push(`- Killer's gold at the kill: ${killer.gold}g (${signed(diff)}g vs me)`);
    }
    lines.push(`- Map action in the 60s prior: ${act.kills} kills, ${act.objectives} objectives`);
    lines.push("");
  });

  return lines.join("\n");
}

module.exports = { buildTimelineReview };
