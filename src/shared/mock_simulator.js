"use strict";

// ---------------------------------------------------------------------------
// Localized diagnostic simulation engine (dev only — `npm run dev:mock`).
//
// Drives the FULL production pipeline end-to-end without League running:
//   1. Draft   — pushes mock champ-select sessions into the pregame window.
//   2. Live    — spins up a real HTTP server on :2999 mimicking Riot's Live
//                Client Data API. The production poll() + liveClient.js +
//                timers.js consume it unchanged, so the overlay's countdowns
//                are driven by real code, not re-simulated here.
//   3. Postgame— tears the server down and pipes mock "Claude" SSE tokens over
//                the coach IPC bridge to exercise the typewriter + caret.
//
// The game clock is ACCELERATED (~18x): one real second advances game-time by
// ACCEL seconds, so the whole objective sequence (grub clear 05:30 -> 4:00
// respawn -> Herald 14:00 -> despawn 19:45 -> Baron 20:00) is exercised inside
// the ~60s live window. Nothing here touches the game client, memory, or screen.
// ---------------------------------------------------------------------------

const http = require("http");

const MOCK_PORT = 2999;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/liveclientdata`;

const DRAFT_MS = 15000;        // champ-select dashboard demo
const LIVE_MS = 60000;         // live-overlay demo
const START_GAME_TIME = 270;   // 04:30 — just before the 05:00 objective spawns
const ACCEL = 18;              // game-seconds per real-second

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve once a window has loaded its HTML, so IPC sends aren't dropped.
function whenReady(win) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve();
    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", () => resolve());
    } else {
      resolve();
    }
  });
}

// ----- Mock champ-select session ----------------------------------------------
const ROLES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
const ALLY_CHAMPS = [86, 64, 103, 22, 412];   // Garen, LeeSin, Ahri, Ashe, Thresh
const ENEMY_CHAMPS = [122, 60, 7, 222, 117];  // Darius, Elise, LeBlanc, Jinx, Lulu

// Reveal ally picks progressively to exercise the "waiting on locks" -> "ready"
// gauge transitions. lockedCount ally cells (in pick order) get a championId.
function champSelectSession(lockedCount) {
  const PICK_ORDER = [0, 2, 4, 1, 3]; // a plausible blue-side reveal order
  const lockedCells = new Set(PICK_ORDER.slice(0, lockedCount));

  const myTeam = ROLES.map((pos, i) => ({
    cellId: i,
    assignedPosition: pos,
    championId: lockedCells.has(i) ? ALLY_CHAMPS[i] : 0,
    summonerId: 1000 + i,
  }));
  const theirTeam = ROLES.map((pos, i) => ({
    cellId: 5 + i,
    assignedPosition: pos,
    championId: ENEMY_CHAMPS[i],
    summonerId: 2000 + i,
  }));

  return {
    localPlayerCellId: 0,
    myTeam,
    theirTeam,
    bans: { myTeamBans: [24, 105], theirTeamBans: [157, 238] },
    timer: { phase: "BAN_PICK", adjustedTimeLeftInPhase: 25000 },
  };
}

// ----- Mock Live Client payload ----------------------------------------------
// Shaped exactly like /liveclientdata/allgamedata so liveClient.activeScores
// and timers.computeTimers parse it with zero special-casing.
function liveGameData(gameTime) {
  const minutes = gameTime / 60;
  const cs = Math.round(minutes * 7.5);
  // A gently rising sawtooth so the post-game gold card looks alive.
  const gold = 500 + Math.round(minutes * 360) + (Math.round(gameTime) % 40) * 6;
  const kills = gameTime > 480 ? 2 : gameTime > 200 ? 1 : 0;
  const deaths = gameTime > 900 ? 1 : 0;
  const assists = gameTime > 600 ? 3 : gameTime > 330 ? 1 : 0;

  // Events fire once their EventTime has passed — same contract as the real API.
  const allEvents = [
    { EventID: 0, EventName: "GameStart", EventTime: 0 },
    { EventID: 1, EventName: "ChampionKill", EventTime: 200 },
    // Grub wave 1 cleared at 05:30 -> timers.js queues a 4:00 respawn.
    { EventID: 2, EventName: "HordeKill", EventTime: 330 },
    { EventID: 3, EventName: "HordeKill", EventTime: 332 },
    { EventID: 4, EventName: "HordeKill", EventTime: 334 },
    { EventID: 5, EventName: "DragonKill", EventTime: 600 },
    { EventID: 6, EventName: "ChampionKill", EventTime: 480 },
    { EventID: 7, EventName: "ChampionKill", EventTime: 900 },
  ];
  const Events = allEvents
    .filter((e) => e.EventTime <= gameTime)
    .sort((a, b) => a.EventTime - b.EventTime);

  const me = {
    summonerName: "PepStatsTester",
    riotIdGameName: "PepStatsTester",
    riotIdTagLine: "NA1",
    championName: "Ahri",
    scores: { creepScore: cs, kills, deaths, assists, wardScore: minutes * 0.8 },
  };

  return {
    activePlayer: {
      summonerName: "PepStatsTester",
      currentGold: gold,
      level: Math.min(18, 1 + Math.floor(minutes / 1.6)),
    },
    allPlayers: [me],
    events: { Events },
    gameData: { gameTime, gameMode: "CLASSIC", mapName: "Map11" },
  };
}

// ----- Phase 1: draft ---------------------------------------------------------
async function draftPhase({ ensure, showOnly, sendTo }) {
  const win = ensure("pregame");
  showOnly("pregame");
  await whenReady(win);

  // Reveal locks one at a time across the draft window.
  const steps = [1, 2, 3, 4, 5];
  const stepGap = Math.floor(DRAFT_MS / (steps.length + 1));
  sendTo("pregame", "champ-select", champSelectSession(0));
  for (const locked of steps) {
    await sleep(stepGap);
    sendTo("pregame", "champ-select", champSelectSession(locked));
  }
  await sleep(stepGap);
}

// ----- Phase 2: live server ---------------------------------------------------
let _server = null;
let _liveStart = 0;

function currentGameTime() {
  const elapsedReal = (Date.now() - _liveStart) / 1000;
  return START_GAME_TIME + elapsedReal * ACCEL;
}

function startLiveServer() {
  return new Promise((resolve, reject) => {
    _server = http.createServer((req, res) => {
      // Only the one endpoint the poller hits is implemented.
      if (req.url && req.url.startsWith("/liveclientdata/allgamedata")) {
        const body = JSON.stringify(liveGameData(currentGameTime()));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    _server.on("error", reject);
    _server.listen(MOCK_PORT, "127.0.0.1", () => {
      _liveStart = Date.now();
      // Point the production liveClient at our loopback http server.
      process.env.PEPSTATS_LIVE_BASE = MOCK_BASE;
      resolve();
    });
  });
}

function stopLiveServer() {
  delete process.env.PEPSTATS_LIVE_BASE;
  return new Promise((resolve) => {
    if (!_server) return resolve();
    _server.close(() => {
      _server = null;
      resolve();
    });
  });
}

// ----- Phase 4: post-game coach stream ---------------------------------------
const COACH_TOKENS = [
  "Solid ", "game", ".\n\n", "Your ", "early ", "CS ", "pace ", "was ",
  "strong", "—", "you ", "hit ", "your ", "first ", "spike ", "on ", "time", ".\n",
  "Watch ", "your ", "recall ", "timing ", "around ", "the ", "6:00 ", "dragon", ":\n",
  "you ", "backed ", "a ", "wave ", "too ", "late ", "and ", "missed ", "the ",
  "tempo ", "to ", "contest ", "it", ".\n\n", "Next ", "game", ", ", "look ",
  "to ", "track ", "the ", "grub ", "respawn ", "and ", "rotate ", "early", ".",
];

async function completionPhase({ ensure, showOnly, sendTo }) {
  await stopLiveServer();

  const win = ensure("postgame");
  showOnly("postgame");
  await whenReady(win);

  // Hand the postgame UI a final snapshot so the summary cards/graph fill in.
  const finalData = liveGameData(currentGameTime());
  const finalGameTime = currentGameTime();
  const scores = {
    gameTime: finalGameTime,
    cs: finalData.allPlayers[0].scores.creepScore,
    csPerMin: finalData.allPlayers[0].scores.creepScore / (finalGameTime / 60),
    gold: finalData.activePlayer.currentGold,
    kda: {
      k: finalData.allPlayers[0].scores.kills,
      d: finalData.allPlayers[0].scores.deaths,
      a: finalData.allPlayers[0].scores.assists,
    },
    champion: finalData.allPlayers[0].championName,
    events: finalData.events.Events,
  };
  sendTo("postgame", "last-game", {
    scores,
    replay: { name: "EUW1-MOCK_SIM.rofl", sizeBytes: 17_825_792, modified: Date.now() },
  });

  // Pipe the mock SSE token stream so the typewriter + blink caret run.
  await sleep(600);
  for (const tok of COACH_TOKENS) {
    sendTo("postgame", "coach-chunk", tok);
    await sleep(45);
  }
  sendTo("postgame", "coach-done", {});
}

// ----- Orchestrator -----------------------------------------------------------
async function startMockSimulation(api) {
  try {
    console.log("[mock] simulation starting — draft phase");
    await draftPhase(api);

    console.log("[mock] starting live server on :" + MOCK_PORT);
    await startLiveServer();
    // The production poll() loop now sees a "live game" and flips to the overlay
    // on its own. We just hold here while it ticks.
    await sleep(LIVE_MS);

    console.log("[mock] match complete — post-game coach stream");
    await completionPhase(api);

    console.log("[mock] simulation finished");
  } catch (err) {
    console.error("[mock] simulation failed:", err && err.stack ? err.stack : err);
    try {
      await stopLiveServer();
    } catch (_) {
      /* best effort */
    }
  }
}

module.exports = { startMockSimulation };
