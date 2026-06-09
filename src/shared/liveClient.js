"use strict";

// Riot-sanctioned in-game data. Only serves data while a match is live
// (incl. Practice Tool / customs). Self-signed cert -> rejectUnauthorized:false.
const https = require("https");

const BASE = "https://127.0.0.1:2999/liveclientdata";

function getJson(pathname, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      BASE + pathname,
      { rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

const getAllGameData = (timeoutMs) => getJson("/allgamedata", timeoutMs);

// Find the active (local) player in the allPlayers feed. Matches on Riot ID or
// legacy summoner name, falling back to the first player.
function findMe(data) {
  const players = (data && data.allPlayers) || [];
  const activeName =
    (data && data.activePlayer && data.activePlayer.summonerName) || "";
  return (
    players.find((p) => {
      const riotId =
        p.riotIdGameName && p.riotIdTagLine
          ? p.riotIdGameName + "#" + p.riotIdTagLine
          : p.summonerName;
      return riotId === activeName || p.summonerName === activeName;
    }) ||
    players[0] ||
    null
  );
}

// Mode/map identification. The neutral epic objectives (grubs/herald/dragon/
// baron) exist only on Summoner's Rift (CLASSIC, map 11); everything else
// (ARAM=12, Arena, URF, …) has no jungle, so callers suppress those timers.
function gameInfo(data) {
  const gd = (data && data.gameData) || {};
  const gameMode = gd.gameMode || "";
  const mapNumber = typeof gd.mapNumber === "number" ? gd.mapNumber : null;
  const isClassic = gameMode === "CLASSIC" || mapNumber === 11;
  return { gameMode, mapNumber, isClassic };
}

// The active player's assigned position ("TOP"/"JUNGLE"/… or "" off-SR). Used
// to pick the right rank baseline before building the comparison.
function activeRole(data) {
  const me = findMe(data);
  return (me && me.position) || "";
}

// The enemy team's champions, in a stable lane order, with a fixed slot index.
// This is the SAME roster the in-game Tab scoreboard shows (championName/team/
// position straight from allPlayers) — it is NOT position/fog inference. It only
// labels the manual Flash/Ult tracker rows; the timers themselves run purely off
// the user's own hotkey presses (see main.js syncTrackers). Slot is stable so a
// given hotkey always maps to the same enemy for the whole match.
const _ROLE_ORDER = { TOP: 0, JUNGLE: 1, MIDDLE: 2, BOTTOM: 3, UTILITY: 4 };
function enemyRoster(data) {
  const players = (data && data.allPlayers) || [];
  const me = findMe(data);
  if (!me) return [];
  const ord = (p) => {
    const r = _ROLE_ORDER[p.position];
    return typeof r === "number" ? r : 99;
  };
  return players
    .filter((p) => p.team && me.team && p.team !== me.team)
    .slice()
    .sort((a, b) => ord(a) - ord(b) || (a.championName || "").localeCompare(b.championName || ""))
    .slice(0, 5)
    .map((p, i) => ({ slot: i, champion: p.championName || "?", position: p.position || "" }));
}

function activeScores(data) {
  const me = findMe(data);
  const gameTime = (data && data.gameData && data.gameData.gameTime) || 0;
  const minutes = gameTime / 60;
  const cs = (me && me.scores && me.scores.creepScore) || 0;

  return {
    gameTime,
    cs,
    csPerMin: minutes > 0 ? cs / minutes : 0,
    gold: (data && data.activePlayer && data.activePlayer.currentGold) || 0,
    kda: me && me.scores
      ? { k: me.scores.kills, d: me.scores.deaths, a: me.scores.assists }
      : { k: 0, d: 0, a: 0 },
    champion: (me && me.championName) || "",
    events: (data && data.events && data.events.Events) || [],
  };
}

function kdaRatio(sc) {
  const k = (sc && sc.kills) || 0;
  const d = (sc && sc.deaths) || 0;
  const a = (sc && sc.assists) || 0;
  return d > 0 ? (k + a) / d : k + a;
}

function teamKills(players, team) {
  return players
    .filter((p) => p.team === team)
    .reduce((s, p) => s + ((p.scores && p.scores.kills) || 0), 0);
}

// Compares the active player against a rank baseline (you vs the average player
// at your rank), not a lane opponent. This is the right reference in every mode
// — ARAM and other no-lane modes have no role opponent to compare against, and
// even on the Rift it answers "how am I doing for my elo?" rather than "vs this
// one enemy". `baseline` is a rankBaseline object (or null to omit comparison).
// Gold is still your value only (the feed exposes no other player's gold).
function compareStats(data, baseline) {
  const players = (data && data.allPlayers) || [];
  const gameTime = (data && data.gameData && data.gameData.gameTime) || 0;
  const minutes = gameTime / 60;
  const me = findMe(data);

  const gold = (data && data.activePlayer && data.activePlayer.currentGold) || 0;
  const result = {
    role: (me && me.position) || "",
    rank: (baseline && baseline.rank) || null,
    baselineSource: (baseline && baseline.source) || null,
    csmYou: 0,
    csmBaseline: null,
    csmDiff: null,
    gpm: minutes > 0 ? gold / minutes : 0,
    kp: { you: 0, baseline: null },
    kda: { you: 0, baseline: null },
    lvl: { you: 0 },
    vision: { you: 0, baseline: null },
  };
  if (!me) return result;

  const sc = me.scores || {};
  result.csmYou = minutes > 0 ? (sc.creepScore || 0) / minutes : 0;
  result.lvl.you = me.level || 0;
  result.kda.you = kdaRatio(sc);
  result.vision.you = sc.wardScore != null ? Math.round(sc.wardScore) : 0;
  const myTK = teamKills(players, me.team);
  result.kp.you =
    myTK > 0 ? Math.round((((sc.kills || 0) + (sc.assists || 0)) / myTK) * 100) : 0;

  if (baseline) {
    result.csmBaseline = baseline.csmPerMin;
    result.csmDiff = result.csmYou - baseline.csmPerMin;
    result.kp.baseline = baseline.kp;
    result.kda.baseline = baseline.kda;
    // Vision is reported cumulatively, so scale the per-minute baseline to the
    // current game time for an apples-to-apples comparison.
    result.vision.baseline = Math.round((baseline.visionPerMin || 0) * minutes);
  }
  return result;
}

// Direct lane opponent = the enemy-team player sharing the active player's
// assigned position. Only meaningful on the Rift (positions are blank off-SR).
function laneOpponent(data, me) {
  const players = (data && data.allPlayers) || [];
  const self = me || findMe(data);
  if (!self || !self.position) return null;
  return players.find((p) => p.team !== self.team && p.position === self.position) || null;
}

// Live CS differential vs the direct lane opponent (read-only, sanctioned feed).
// { available, you, opp, diff, role, oppChampion, oppName } — available:false in
// no-lane modes (ARAM/Arena) or before the opponent is resolvable.
function csDifferential(data) {
  const me = findMe(data);
  if (!me) return { available: false };
  const youCs = (me.scores && me.scores.creepScore) || 0;
  const role = me.position || "";
  const opp = laneOpponent(data, me);
  if (!opp) return { available: false, you: youCs, role };
  const oppCs = (opp.scores && opp.scores.creepScore) || 0;
  return {
    available: true,
    you: youCs,
    opp: oppCs,
    diff: youCs - oppCs,
    role,
    oppChampion: opp.championName || "",
    oppName: (opp.riotIdGameName || opp.summonerName || ""),
  };
}

// Lane-matchup dossier: you vs your direct lane opponent (champion / CS-per-min
// / KDA / level), all from the sanctioned allPlayers feed — the same data the
// in-game Tab scoreboard shows. hasOpp:false off-SR or before the opponent
// resolves.
function laneDossier(data) {
  const me = findMe(data);
  if (!me) return { hasOpp: false };
  const minutes = ((data && data.gameData && data.gameData.gameTime) || 0) / 60;
  const stat = (p) => {
    const sc = p.scores || {};
    return {
      champion: p.championName || "",
      csm: minutes > 0 ? +(((sc.creepScore || 0)) / minutes).toFixed(1) : 0,
      kda: +kdaRatio(sc).toFixed(1),
      lvl: p.level || 0,
    };
  };
  const opp = me.position ? laneOpponent(data, me) : null;
  return { hasOpp: !!opp, role: me.position || "", you: stat(me), opp: opp ? stat(opp) : null };
}

// Major combat milestones for the active player, for the highlight toast. Reads
// only the public event stream (kills/multikills/objectives the scoreboard log
// already shows). `sinceTime` filters to events newer than the last poll so each
// fires once. Single kills are intentionally NOT toasted (too frequent) — only
// first blood, multikills, and team/enemy epic objectives.
const _MULTI = { 2: "Double Kill", 3: "Triple Kill", 4: "Quadra Kill", 5: "Penta Kill" };
const _OBJ = { DragonKill: "Dragon", BaronKill: "Baron", HeraldKill: "Rift Herald" };
function playerHighlights(data, sinceTime) {
  const me = findMe(data);
  const players = (data && data.allPlayers) || [];
  const events = (data && data.events && data.events.Events) || [];
  if (!me) return [];
  const myNames = new Set([me.summonerName, me.riotIdGameName].filter(Boolean));
  const teamOf = (name) => {
    const p = players.find((x) => x.summonerName === name || x.riotIdGameName === name);
    return p ? p.team : null;
  };
  const out = [];
  for (const e of events) {
    if (typeof e.EventTime !== "number" || e.EventTime <= sinceTime) continue;
    const t = e.EventTime;
    if (e.EventName === "FirstBlood" && myNames.has(e.Recipient)) {
      out.push({ t, kind: "good", label: "First Blood", sub: me.championName || "" });
    } else if (e.EventName === "Multikill" && myNames.has(e.KillerName)) {
      out.push({ t, kind: "kill", label: _MULTI[e.KillStreak] || e.KillStreak + "× Kill", sub: me.championName || "" });
    } else if (_OBJ[e.EventName]) {
      const mine = teamOf(e.KillerName) === me.team;
      out.push({ t, kind: mine ? "good" : "bad", label: (mine ? "Your team" : "Enemy") + " · " + _OBJ[e.EventName], sub: e.Stolen === "True" ? "Stolen!" : "" });
    } else if (e.EventName === "Ace" && (e.AcingTeam === me.team || myNames.has(e.Acer))) {
      out.push({ t, kind: "good", label: "ACE", sub: "" });
    }
  }
  return out;
}

// Post-match performance badges, computed from the SANCTIONED
// final allPlayers snapshot — every player's kills/deaths/assists/creepScore/
// wardScore is in the official feed (the same data the end-game scoreboard shows
// you). No enemy-hidden or out-of-game data. Returns an array of
// { key, label, cls, desc } the post-game window and the coach payload share.
function matchAwards(data) {
  const players = (data && data.allPlayers) || [];
  const me = findMe(data);
  if (!me || players.length < 2) return [];

  const sc = (p) => p.scores || {};
  const kdaOf = (p) => kdaRatio(sc(p));
  const teamSet = players.filter((p) => p.team === me.team);

  // True only when `me` is the SOLE maximum of `metric` over `set` (ties don't
  // earn the badge), and there's someone to beat.
  const topUnique = (set, metric, minBest = -Infinity) => {
    if (set.length < 2) return false;
    let best = -Infinity, ties = 0;
    for (const p of set) {
      const v = metric(p);
      if (v > best) { best = v; ties = 1; }
      else if (v === best) ties++;
    }
    return best > minBest && ties === 1 && metric(me) === best;
  };

  const out = [];
  const myDeaths = (sc(me).deaths || 0);
  const myKA = (sc(me).kills || 0) + (sc(me).assists || 0);
  const myTK = teamKills(players, me.team);
  const myKp = myTK > 0 ? (((sc(me).kills || 0) + (sc(me).assists || 0)) / myTK) * 100 : 0;

  // ACE = best KDA in the lobby; MVP = best KDA on your team (if not already ACE).
  if (topUnique(players, kdaOf)) out.push({ key: "ace", label: "ACE", cls: "gold", desc: "Best KDA in the match" });
  else if (topUnique(teamSet, kdaOf)) out.push({ key: "mvp", label: "MVP", cls: "gold", desc: "Best KDA on your team" });

  if (topUnique(players, (p) => sc(p).wardScore || 0, 0))
    out.push({ key: "vision", label: "Vision Demon", cls: "gold", desc: "Highest vision score in the match" });
  if (topUnique(players, (p) => sc(p).creepScore || 0, 0))
    out.push({ key: "cs", label: "Farm King", cls: "silver", desc: "Most CS in the match" });
  if (myDeaths === 0 && myKA >= 5)
    out.push({ key: "unkillable", label: "Unkillable", cls: "silver", desc: "Zero deaths" });
  if (myKp >= 65)
    out.push({ key: "playmaker", label: "Playmaker", cls: "silver", desc: Math.round(myKp) + "% kill participation" });

  // "Troll Bait" — first to die in 3+ consecutive teamfights. Computed from the
  // public ChampionKill event log (same combat feed the scoreboard uses): kills
  // within 12s are one fight; a fight with 2+ kills counts as a teamfight; we
  // track the longest run of teamfights whose FIRST victim was you.
  const streak = firstBloodStreak(data, me);
  if (streak >= 3)
    out.push({ key: "trollbait", label: "Troll Bait", cls: "red", desc: "Died first in " + streak + " straight teamfights" });

  return out;
}

const FIGHT_GAP = 12;        // seconds; kills within this window are one fight
const MIN_FIGHT_KILLS = 2;   // a "teamfight" has at least this many kills
function firstBloodStreak(data, me) {
  const events = (data && data.events && data.events.Events) || [];
  const myNames = new Set(
    [me && me.summonerName, me && me.riotIdGameName].filter(Boolean)
  );
  if (!myNames.size) return 0;

  const kills = events
    .filter((e) => e.EventName === "ChampionKill" && typeof e.EventTime === "number")
    .sort((a, b) => a.EventTime - b.EventTime);

  // Group sequential kills into fights by time gap.
  const fights = [];
  let cur = [];
  for (const k of kills) {
    if (cur.length && k.EventTime - cur[cur.length - 1].EventTime > FIGHT_GAP) {
      fights.push(cur);
      cur = [];
    }
    cur.push(k);
  }
  if (cur.length) fights.push(cur);

  let streak = 0, best = 0;
  for (const f of fights) {
    if (f.length < MIN_FIGHT_KILLS) continue; // skirmish/solo pick — not a teamfight
    if (myNames.has(f[0].VictimName)) {
      streak++;
      if (streak > best) best = streak;
    } else {
      streak = 0;
    }
  }
  return best;
}

module.exports = {
  getAllGameData,
  activeScores,
  compareStats,
  gameInfo,
  activeRole,
  findMe,
  enemyRoster,
  laneOpponent,
  csDifferential,
  laneDossier,
  playerHighlights,
  matchAwards,
};
