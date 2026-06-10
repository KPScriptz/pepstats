"use strict";

const { app, BrowserWindow, ipcMain, globalShortcut, screen, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");

const liveClient = require("./shared/liveClient");
const lcu = require("./shared/lcu");
const { LcuSocket } = require("./shared/lcuSocket");
const { computeTimers } = require("./shared/timers");
const rankBaseline = require("./shared/rankBaseline");
const rankProgress = require("./shared/rankProgress");
const riotApi = require("./shared/riotApi");
const builds = require("./shared/builds");
const draftCoach = require("./shared/draftCoach");
const advisor = require("./shared/advisor");
const buildDataEngine = require("./utils/buildDataEngine");
const friendsEngine = require("./utils/friendsEngine");
const postgameEngine = require("./utils/postgameEngine");
const tftEngine = require("./utils/tftEngine");
const tftAnalytics = require("./utils/tftAnalyticsEngine");
const liveTelemetry = require("./utils/liveGameTelemetry");
const lcuHistory = require("./shared/lcuHistory");
const deepCoach = require("./shared/deepCoach");
const processWatch = require("./shared/process");
const replays = require("./shared/replays");

// App icon (window + taskbar). Packaged builds also reference build/icon.ico.
const ICON_PATH = path.join(__dirname, "..", "build", "icon.ico");

// ----- Tunables ----------------------------------------------------------
const POLL_MS = 1000;          // live-game heartbeat (1 Hz)
const LIVE_TIMEOUT_MS = 800;   // tight enough to never lag the poll, loose
                               // enough not to flap on a busy machine
const PROC_POLL_MS = 5000;     // process watcher cadence (low overhead)

// ----- App state machine -------------------------------------------------
// idle -> pregame (champ select) -> ingame (match live) -> postgame (match ended)
const STATE = { IDLE: "idle", PREGAME: "pregame", INGAME: "ingame", POSTGAME: "postgame" };

const windows = { ingame: null, pregame: null, postgame: null, home: null };
let appState = STATE.IDLE;
let clientPhase = "None"; // last known LCU gameflow phase, for the home window
let designMode = false;
let lastSnapshot = null; // most recent live-game data, for the post-game coach
let lastReplay = null;   // newest .rofl metadata captured at match end
let sawLiveGame = false;
let clientUp = false;    // LeagueClient.exe seen by the process watcher
let lcuSocket = null;
let accountRank = null;  // resolved once from the LCU, then cached for the session
let liveBaseline = null; // overlay comparison baseline, refreshed off the hot path
let liveBaselineKey = ""; // mode|role the cached baseline was computed for
let lastHighlightTime = 0; // gameTime watermark for the highlight-toast feed
let itemGoldMap = null;    // ddragon item -> total gold, for the live gold-value diff

// Live team gold-VALUE differential from visible items (sanctioned: every
// player's items are on the Tab scoreboard / allPlayers feed). This is item
// value, not total gold (the live feed never exposes other players' gold).
function computeGoldDiff(live) {
  if (!itemGoldMap) return null;
  const players = (live && live.allPlayers) || [];
  const me = liveClient.findMe(live);
  if (!me || !players.length) return null;
  let mine = 0, enemy = 0;
  for (const p of players) {
    let v = 0;
    for (const it of p.items || []) v += itemGoldMap[String(it.itemID)] || 0;
    if (p.team === me.team) mine += v;
    else enemy += v;
  }
  return { mine, enemy, diff: mine - enemy };
}

// ----- Window factories --------------------------------------------------
function preload() {
  return path.join(__dirname, "preload.js");
}

// Engine 3: transparent, click-through overlay over Borderless League.
// NOTE: app.disableHardwareAcceleration() is intentionally NOT called, so the
// GPU keeps compositing the overlay for ~0% in-game FPS impact.
function createOverlay() {
  // Full-screen transparent canvas: the widget floats inside it and can be
  // dragged/resized anywhere in Design Mode (positions persisted client-side).
  // Click-through in Live Mode means the empty canvas passes every click to the
  // game — zero gameplay interference.
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    icon: ICON_PATH,
    webPreferences: { preload: preload(), contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true }); // boot click-through (Live Mode)
  win.loadFile(path.join(__dirname, "windows/ingame/index.html"));
  win.on("closed", () => (windows.ingame = null));
  return win;
}

function createDashboard(file, role, opts = {}) {
  // Clamp the requested size to the monitor's usable area so a large default
  // (e.g. 1920x1080) never opens taller/wider than the screen (taskbar, DPI).
  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(opts.width || 1000, work.width);
  const height = Math.min(opts.height || 660, work.height);
  const win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(opts.minWidth || 0, work.width),
    minHeight: Math.min(opts.minHeight || 0, work.height),
    center: true,
    show: false,
    frame: false,
    backgroundColor: "#12141a",
    resizable: true,
    icon: ICON_PATH,
    skipTaskbar: false, // dashboards (esp. the home client) live in the taskbar
    webPreferences: {
      preload: preload(),
      contextIsolation: true,
      sandbox: true,
      additionalArguments: ["--pepstats-role=" + role],
    },
  });
  win.loadFile(file);
  win.on("closed", () => (windows[role] = null));
  return win;
}

function ensure(role) {
  if (windows[role] && !windows[role].isDestroyed()) return windows[role];
  if (role === "ingame") windows.ingame = createOverlay();
  if (role === "pregame")
    windows.pregame = createDashboard(path.join(__dirname, "windows/pregame/index.html"), "pregame");
  if (role === "postgame")
    windows.postgame = createDashboard(path.join(__dirname, "windows/postgame/index.html"), "postgame", {
      width: 1280, height: 720, minWidth: 1000, minHeight: 680,
    });
  if (role === "home")
    windows.home = createDashboard(path.join(__dirname, "windows/home/index.html"), "home", {
      width: 1920, height: 1080, minWidth: 1280, minHeight: 720,
    });
  return windows[role];
}

// The home/client window is the app's taskbar presence whenever no match-flow
// window (champ select / overlay / post-game) owns the screen.
function showHome() {
  appState = STATE.IDLE;
  ensure("home");
  showOnly("home");
}

function showOnly(role) {
  for (const r of Object.keys(windows)) {
    const w = windows[r];
    if (r === role) {
      ensure(r).show();
    } else if (w && !w.isDestroyed()) {
      w.hide();
    }
  }
}

function sendTo(role, channel, payload) {
  const w = windows[role];
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

// ----- Engine 3: overlay design / live mode ------------------------------
function setDesignMode(on) {
  designMode = on;
  const w = ensure("ingame");
  if (!w || w.isDestroyed()) return;
  if (on) {
    // Design Mode: capture the mouse so the HUD can be dragged/repositioned, and
    // surface the overlay even outside a match so it can be placed any time.
    w.setIgnoreMouseEvents(false);
    w.show();
  } else {
    // Live Mode: absolute click-through — zero gameplay mouse interception. The
    // overlay belongs on screen only during a live match, so if no game is in
    // progress, keep it hidden instead of stuck on the desktop.
    w.setIgnoreMouseEvents(true, { forward: true });
    if (appState !== STATE.INGAME) w.hide();
  }
  w.webContents.send("mode-change", on ? "design" : "live");
}

// ----- Engine 1: LCU event socket (champ select) -------------------------
function startLcuSocket() {
  if (lcuSocket) return;
  lcuSocket = new LcuSocket();
  lcuSocket.on("champ-select", (data) => {
    if (appState === STATE.INGAME) return; // a live game takes priority
    if (appState !== STATE.PREGAME) {
      appState = STATE.PREGAME;
      ensure("pregame");
      showOnly("pregame");
    }
    sendTo("pregame", "champ-select", data);
  });
  lcuSocket.on("champ-select-end", () => {
    // Dodge / lobby return (not a game start) -> back to the home client.
    if (appState === STATE.PREGAME) showHome();
  });
  lcuSocket.start();
}

// Resolve the account rank once from the LCU, then cache it. Returns null while
// still unresolved (e.g. client not up yet) so the next poll retries; the
// baseline falls back to a sensible default tier until then.
async function ensureRank() {
  if (accountRank) return accountRank;
  accountRank = await rankBaseline.getAccountRank(lcu);
  return accountRank;
}

// Resolve the overlay comparison baseline OFF the poll hot path so live stats
// (CS/KDA/KP/level) always update at full 1 Hz, even if the rank/LCU/baseline
// lookups are slow. Only recomputes when the mode or role changes.
function refreshLiveBaseline(info, role) {
  const key = (info.gameMode || "") + "|" + (role || "");
  if (key === liveBaselineKey && liveBaseline) return;
  liveBaselineKey = key;
  (async () => {
    try {
      const rank = await ensureRank();
      const cfg = loadConfig();
      liveBaseline = await rankBaseline.getBaseline({ tier: rank, role, mode: info.gameMode, apiUrl: cfg.baselineApiUrl });
    } catch (_) {
      /* keep last baseline */
    }
  })();
}

// ----- Skill-order hint (overlay "max next") -----------------------------
// Compliant + offline: the recommended Q/W/E max priority comes from the
// curated builds dictionary (no key, no network), and "what to put the next
// point in" is computed from the active player's OWN ability ranks + level that
// the sanctioned Live Client API already exposes. No enemy or hidden data.
function abilityRanks(live) {
  const ab = (live && live.activePlayer && live.activePlayer.abilities) || {};
  const rank = (k) => (ab[k] && typeof ab[k].abilityLevel === "number" ? ab[k].abilityLevel : 0);
  return { Q: rank("Q"), W: rank("W"), E: rank("E"), R: rank("R") };
}

function computeSkillHint(live, championName) {
  try {
    const champKey = riotApi.champKey(championName) || championName;
    const set = champKey && builds.getVariants(champKey);
    if (!set) return null; // uncurated champ -> no hint (row stays hidden)
    const order = set.variants[set.order[0]].skills; // ["Q","W","E"] max priority
    const level = (live && live.activePlayer && live.activePlayer.level) || 0;
    const ranks = abilityRanks(live);
    // You earn an ult point at levels 6 / 11 / 16; take it as soon as it's free.
    const ultEntitled = level >= 16 ? 3 : level >= 11 ? 2 : level >= 6 ? 1 : 0;
    let next;
    if ((ranks.R || 0) < ultEntitled) next = "R";
    else next = order.find((k) => (ranks[k] || 0) < 5) || order[order.length - 1];
    return { order, next, ranks };
  } catch (_) {
    return null;
  }
}

// ----- Engine 2: phase-detection heartbeat -------------------------------
// Re-entrancy guard: poll() awaits network/LCU calls and runs on a fixed
// interval, so a slow tick must not overlap the next one (double window
// transitions, interleaved tracker register/unregister).
let _polling = false;
async function poll() {
  if (_polling) return;
  _polling = true;
  try { await _pollImpl(); } finally { _polling = false; }
}
async function _pollImpl() {
  let live = null;
  try {
    live = await liveClient.getAllGameData(LIVE_TIMEOUT_MS);
  } catch (_) {
    live = null;
  }

  if (live) {
    // A match is in progress.
    sawLiveGame = true;
    const scores = liveClient.activeScores(live);
    // Capture post-match badges from the sanctioned final snapshot every tick;
    // the last good one is what the post-game window + coach use at match end.
    scores.awards = liveClient.matchAwards(live);
    lastSnapshot = scores;

    // Compare against the rank baseline. The baseline is refreshed in the
    // background (not awaited) so the overlay's own stats update every tick.
    const info = liveClient.gameInfo(live);
    const role = liveClient.activeRole(live);
    refreshLiveBaseline(info, role);
    const compare = liveClient.compareStats(live, liveBaseline);
    const timers = computeTimers(scores.gameTime, scores.events, { isClassic: info.isClassic });
    const skill = computeSkillHint(live, scores.champion);
    const dossier = liveClient.laneDossier(live); // #2 you-vs-lane-opponent
    const goldDiff = computeGoldDiff(live); // P3.4 live gold-value inventory diff
    if (appState !== STATE.INGAME) {
      appState = STATE.INGAME;
      // Start watching highlights from now, so launching mid-game doesn't replay
      // the whole match's events as toasts.
      lastHighlightTime = scores.gameTime;
      const overlayWindow = ensure("ingame");
      showOnly("ingame");
      setDesignMode(false); // matches go live (click-through) by default
      // Edge case A: as the match ticks over to InProgress, hard-disable any
      // lingering drag/design interaction so a stuck design state can never
      // intercept the mouse during gameplay, then tell the renderer to drop the
      // design outline visually.
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      }
      sendTo("ingame", "force-design-mode-off");
      liveTelemetry.start(); // begin CSD telemetry for this match
      // The ddragon item-gold map loads once at startup; if that fetch failed
      // (offline launch), retry as a match starts so gold-diff isn't dead forever.
      if (!itemGoldMap) riotApi.itemGold().then((m) => { itemGoldMap = m; }).catch(() => {});
    }
    sendTo("ingame", "overlay", { scores, compare, timers, skill, dossier, goldDiff, mode: designMode ? "design" : "live" });

    // #11 — fire a highlight toast for each NEW major milestone (first blood,
    // multikills, epic objectives) from the sanctioned event stream.
    const highlights = liveClient.playerHighlights(live, lastHighlightTime);
    for (const h of highlights) sendTo("ingame", "highlight", h);
    lastHighlightTime = scores.gameTime;
    return;
  }

  // No live game. Was one just running? -> post-game.
  if (sawLiveGame && appState === STATE.INGAME) {
    appState = STATE.POSTGAME;
    liveTelemetry.stop(); // match ended — halt CSD telemetry
    try {
      lastReplay = replays.latestReplay();
    } catch (_) {
      lastReplay = null;
    }
    ensure("postgame");
    showOnly("postgame");
    sendTo("postgame", "last-game", { scores: lastSnapshot, replay: lastReplay, coach: coachConfigStatus() });
    sendTo("home", "home-update");
    sawLiveGame = false;
    return;
  }

  // Client offline: nothing to poll, but keep the home client available so the
  // app still has a taskbar presence.
  if (!clientUp) {
    clientPhase = "None";
    // The client closed. If we were parked in a match-flow window (post-game or
    // champ-select), fall back to home instead of staying stuck there forever.
    if (appState !== STATE.IDLE) showHome();
    else ensure("home");
    return;
  }

  let phase = "None";
  try {
    phase = await lcu.getGameflowPhase();
  } catch (_) {
    phase = "None";
  }
  clientPhase = phase;

  if (phase === "ChampSelect" && appState !== STATE.PREGAME) {
    appState = STATE.PREGAME;
    ensure("pregame");
    showOnly("pregame");
    return;
  }

  // Once the player leaves the end-of-game screen, return to the home client.
  const endScreen = phase === "EndOfGame" || phase === "PreEndOfGame" || phase === "WaitingForStats";
  if (appState === STATE.POSTGAME && !endScreen) {
    showHome();
    return;
  }

  // Default resting state when not in any match flow: the home client.
  if (appState === STATE.IDLE) showHome();
}

// ----- Process watcher (start/stop socket, gate LCU polling) -------------
async function pollProcess() {
  try {
    clientUp = await processWatch.isClientRunning();
  } catch (_) {
    clientUp = false;
  }
  // League may have launched (or been installed) after us; re-probe its install
  // dir so the LCU socket can find the lockfile. init() no-ops once resolved.
  if (clientUp) lcu.init();
}

// ----- Engine 4: post-game AI coach (streaming, your own data only) ------
const COACH_SYSTEM =
  "You are a Challenger-level League of Legends coach giving a concise post-match " +
  "review. Give EXACTLY 3 macro takeaways (wave management, recall timing, " +
  "objective routing, pathing, teamfight positioning).\n\n" +
  "Hard rules:\n" +
  "- No title line, no intro sentence, no closing summary, no tables, no horizontal " +
  "rules (no '---').\n" +
  "- Exactly 3 takeaways. Keep the whole review under 160 words.\n" +
  "- Be direct, specific to this player's data, and kind.\n\n" +
  "Format in Markdown EXACTLY like this:\n" +
  "**1. Short punchy title**\n" +
  "One sentence on what happened.\n" +
  "_Fix:_ one concrete action.\n\n" +
  "**2. Short punchy title**\n" +
  "One sentence.\n" +
  "_Fix:_ one concrete action.\n\n" +
  "**3. Short punchy title**\n" +
  "One sentence.\n" +
  "_Fix:_ one concrete action.";

// Used when we have the real match timeline (death-by-death context). Asks for a
// macro playbook focused on preventing the specific deaths in the data.
const DEEP_COACH_SYSTEM =
  "You are a Challenger-level League of Legends macro coach. You are given a " +
  "death-by-death breakdown from the player's OWN match timeline: their gold/" +
  "level/CS at each death, the gold the previous minute, the killer's gold lead, " +
  "and how much map action happened just before.\n\n" +
  "Write a 'Macro Playbook Review'. Hard rules:\n" +
  "- Open with ONE bold sentence naming the single biggest recurring pattern " +
  "behind these deaths.\n" +
  "- Then give EXACTLY 3 numbered fixes about POSITIONING and MACRO (recall " +
  "timing, wave state before roaming/fighting, vision before objectives, when to " +
  "give up a play) that would have prevented these specific deaths.\n" +
  "- Reference concrete numbers from the data (gold deficits, timings).\n" +
  "- No tables, no horizontal rules, under 200 words.\n\n" +
  "Format:\n" +
  "**One-sentence pattern.**\n\n" +
  "**1. Title**\nWhat to change, tied to the data.\n\n" +
  "**2. Title**\n…\n\n" +
  "**3. Title**\n…";

function loadConfig() {
  const candidates = [
    path.join(app.getPath("userData"), "config.json"),
    path.join(__dirname, "..", "config.json"),
  ];
  for (const p of candidates) {
    try {
      // Strip a leading UTF-8 BOM — JSON.parse throws on it, and editors (or
      // PowerShell's Out-File) can add one to a hand-edited config.json.
      return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
    } catch (_) {
      /* try next */
    }
  }
  return {};
}

// Persist settings edited from the home window. Writes to userData (always
// writable, unlike the install dir) so it round-trips with loadConfig's first
// candidate. Merges over whatever is already there.
function saveConfig(patch) {
  const file = path.join(app.getPath("userData"), "config.json");
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    cur = {};
  }
  const next = { ...cur, ...patch };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

// ----- Saved profile snapshot (works with the client closed) -----------------
// Whenever we successfully build the home summary (from the live client or the
// Riot API) we cache it to disk. When the client is later closed AND no Riot key
// is set, we serve this snapshot so the app still shows the user's saved account
// instead of an empty screen.
function lastSummaryFile() {
  return path.join(app.getPath("userData"), "last-summary.json");
}
function saveLastSummary(summary) {
  if (!summary || !summary.summoner) return;
  try {
    fs.writeFileSync(lastSummaryFile(), JSON.stringify({ ...summary, savedAt: Date.now() }, null, 2));
  } catch (_) { /* best effort */ }
}
function loadLastSummary() {
  try {
    const s = JSON.parse(fs.readFileSync(lastSummaryFile(), "utf8"));
    return s && s.summoner ? { ...s, cached: true } : null;
  } catch (_) {
    return null;
  }
}

// ----- Theme / customization -------------------------------------------------
const THEME_DEFAULTS = {
  theme: "dark", // "dark" | "light"
  accent: "#ff004c", // Blitz neon crimson (was teal #36d6d6)
  density: "comfortable", // "comfortable" | "compact"
  fontScale: 1, // 0.9 .. 1.15
  championSync: true, // tint --accent-dynamic to the selected champion
  overlay: {
    scale: 1, // 0.8 .. 1.3
    opacity: 1, // 0.5 .. 1
    rows: { csm: true, gpm: true, vision: true, kp: true, kda: true, lvl: true },
    // Per-module on/off (toggled from the overlay's Design Mode). Disabled
    // modules are suppressed entirely during live gameplay. The P3.4 extras
    // default OFF (opt-in from Design Mode) so they don't clutter out of the box.
    modules: { stats: true, skill: true, toasts: true, golddiff: false, jungle: false },
  },
};

// Resolve the saved UI settings over the defaults (always returns a full object).
function resolveTheme() {
  const ui = (loadConfig() || {}).ui || {};
  const ov = ui.overlay || {};
  const num = (v, d, lo, hi) =>
    typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    theme: ui.theme === "light" ? "light" : "dark",
    accent: typeof ui.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(ui.accent) ? ui.accent : THEME_DEFAULTS.accent,
    density: ui.density === "compact" ? "compact" : "comfortable",
    fontScale: num(ui.fontScale, 1, 0.85, 1.2),
    championSync: ui.championSync !== false,
    overlay: {
      scale: num(ov.scale, 1, 0.8, 1.3),
      opacity: num(ov.opacity, 1, 0.4, 1),
      rows: { ...THEME_DEFAULTS.overlay.rows, ...(ov.rows || {}) },
      modules: { ...THEME_DEFAULTS.overlay.modules, ...(ov.modules || {}) },
    },
  };
}


// Push the current theme to every open window so changes apply live.
function broadcastTheme() {
  const t = resolveTheme();
  for (const r of Object.keys(windows)) sendTo(r, "theme", t);
}

// Current ranked summary from the best available source: the live LCU when the
// client is open, otherwise the linked Riot account via the official API.
async function getCurrentSummary() {
  const cfg = loadConfig();
  const riotCfg = { riotId: cfg.riotId, region: cfg.region, riotApiKey: cfg.riotApiKey };
  const dir = app.getPath("userData");
  // Client open: live read from the LCU (no key needed) — and cache it for later.
  if (clientUp) {
    const s = await rankProgress.summary(lcu, dir);
    // Race: the client can die between the process check and the LCU read,
    // yielding a summoner-less shell. Serve the saved snapshot instead of a
    // blank profile (saveLastSummary already refuses to store the shell).
    if (!s || !s.summoner) return loadLastSummary() || s;
    saveLastSummary(s);
    return s;
  }
  // Client closed but a Riot key is linked: live read from the official API.
  if (riotCfg.riotId && riotCfg.region && riotCfg.riotApiKey) {
    const profile = await riotApi.fetchProfile(riotCfg);
    const s = rankProgress.buildSummary(dir, profile.summoner, profile.ranked, "riot");
    saveLastSummary(s);
    return s;
  }
  // Client closed and no key: serve the last saved snapshot so the saved account
  // still shows (rather than an empty screen). Live updates resume when the client
  // is reopened or a Riot key is added.
  return loadLastSummary();
}

// One-shot (non-streaming) Claude call that estimates the player's climb from
// their current rank, LP trend, and win rate. Returns { text } or { error }.
async function predictRankUp() {
  const status = coachConfigStatus();
  if (!status.ready) return { error: status.message };
  const cfg = loadConfig();

  let sum = null;
  try {
    sum = await getCurrentSummary();
  } catch (_) {
    sum = null;
  }
  const solo = sum && sum.solo;
  if (!solo) {
    return { error: "No ranked Solo/Duo data found — play a placement game (with the client open) first." };
  }

  // Free, built-in engine by default — no tokens, no cost.
  if (!useClaudeAI()) {
    return { text: advisor.climbAdvice(sum) };
  }

  const wk = (sum && sum.weekly) || {};
  const prog = (sum && sum.progress) || {};
  const facts = [
    `Current rank: ${prog.label}`,
    `Next rank: ${prog.next}`,
    `LP in division: ${solo.lp}`,
    `Record: ${prog.wins}W-${prog.losses}L (${prog.winRate != null ? prog.winRate + "% WR" : "n/a"})`,
    wk.gain != null ? `Net LP last 7 days: ${wk.gain >= 0 ? "+" : ""}${wk.gain}` : "Weekly LP trend: not enough data yet",
  ].join("\n");

  const system =
    "You are a League of Legends ranked-climb coach. Given a player's rank, LP, win " +
    "rate and recent LP trend, give exactly FOUR concrete, high-impact pieces of " +
    "advice that will help them climb to the next rank.\n\n" +
    "Hard rules:\n" +
    "- Do NOT give any timeline, ETA, or estimate of how long it will take (no days, " +
    "weeks, dates, or number-of-games estimates).\n" +
    "- Give exactly 4 advice points, no more, no fewer.\n" +
    "- Make each point specific and actionable for THIS player's rank and trend — not " +
    "generic filler.\n\n" +
    "Format your answer in Markdown exactly like this, with no preamble and no closing " +
    "summary:\n" +
    "**1. Short punchy title**\n" +
    "One or two sentences of concrete advice.\n\n" +
    "**2. Short punchy title**\n" +
    "One or two sentences.\n\n" +
    "**3. Short punchy title**\n" +
    "One or two sentences.\n\n" +
    "**4. Short punchy title**\n" +
    "One or two sentences.";

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": cfg.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.coachModel || "claude-sonnet-4-6",
        max_tokens: 512,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "My ranked snapshot:\n" + facts }],
      }),
    });
    if (!res.ok) {
      let detail = String(res.status);
      try {
        const j = await res.json();
        detail = (j.error && j.error.message) || detail;
      } catch (_) {
        /* keep status */
      }
      return { error: "Forecast error: " + detail };
    }
    const j = await res.json();
    const text =
      (j.content || []).map((b) => (b && b.type === "text" ? b.text : "")).join("").trim();
    return { text: text || "No forecast returned." };
  } catch (e) {
    return { error: "Forecast request failed: " + e.message };
  }
}

// One-shot (non-streaming) Claude call that recommends champions to climb with,
// based on rank, main role, and recent champion performance. { text } | { error }.
async function champAdvice() {
  const status = coachConfigStatus();
  if (!status.ready) return { error: status.message };
  const cfg = loadConfig();

  let sum = null;
  try { sum = await getCurrentSummary(); } catch (_) {}
  const rank = (sum && sum.progress && sum.progress.label) || "Unranked";

  let matches = [];
  if (cfg.riotId && cfg.region && cfg.riotApiKey) {
    const acc = { riotId: cfg.riotId, region: cfg.region, riotApiKey: cfg.riotApiKey };
    try { matches = await riotApi.getMatches(acc, "ranked", 20); } catch (_) {}
    if (!matches.length) { try { matches = await riotApi.getMatches(acc, "all", 20); } catch (_) {} }
  }
  const champs = {}, roles = {};
  for (const m of matches) {
    if (m.remake) continue;
    const c = champs[m.champion] || (champs[m.champion] = { g: 0, w: 0, k: 0, d: 0, a: 0 });
    c.g++; if (m.win) c.w++; c.k += m.k; c.d += m.d; c.a += m.a;
    if (m.position) roles[m.position] = (roles[m.position] || 0) + 1;
  }
  const champList = Object.entries(champs)
    .sort((a, b) => b[1].g - a[1].g).slice(0, 8)
    .map(([n, c]) => `${n}: ${c.g} games, ${Math.round((c.w / c.g) * 100)}% WR, ${c.d ? (((c.k + c.a) / c.d).toFixed(1)) : c.k + c.a} KDA`)
    .join("\n");
  const topRole = Object.entries(roles).sort((a, b) => b[1] - a[1])[0];
  const role = topRole ? topRole[0] : "any role";

  // Free, built-in engine by default — no tokens, no cost.
  if (!useClaudeAI()) {
    const champStats = Object.entries(champs).map(([champion, c]) => ({ champion, ...c }));
    return { text: advisor.champPicks(rank, role, champStats) };
  }

  const facts = `Rank: ${rank}\nMain role: ${role}\nRecent champions:\n${champList || "(no recent ranked games on record)"}`;
  const system =
    "You are a League of Legends climbing coach. Given a player's rank, main role, " +
    "and recent champion performance, recommend 4-5 specific champions they should " +
    "play to rank up. Favor (1) their own strongest performers and (2) reliable, " +
    "easy-to-climb meta picks for their rank and role. For each champion give one " +
    "short line on why it helps them climb. Then add 2-3 concrete things to focus on " +
    "to rank up. Keep it tight and practical, short bullets, no preamble.";

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": cfg.anthropicApiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.coachModel || "claude-sonnet-4-6",
        max_tokens: 700,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "My profile:\n" + facts }],
      }),
    });
    if (!res.ok) {
      let detail = String(res.status);
      try { const j = await res.json(); detail = (j.error && j.error.message) || detail; } catch (_) {}
      return { error: "Suggestion error: " + detail };
    }
    const j = await res.json();
    const text = (j.content || []).map((b) => (b && b.type === "text" ? b.text : "")).join("").trim();
    return { text: text || "No suggestions returned." };
  } catch (e) {
    return { error: "Suggestion request failed: " + e.message };
  }
}

// Assemble everything the home/client window renders.
async function buildHomeData() {
  const cfg = loadConfig();
  const riotCfg = { riotId: cfg.riotId, region: cfg.region, riotApiKey: cfg.riotApiKey };
  const configured = !!(riotCfg.riotId && riotCfg.region && riotCfg.riotApiKey); // full API access
  // An account is "saved" once we know who the user is (Riot ID + region) — whether
  // that came from a full key link OR a one-click connect via the running client.
  // Either way, setup is done; a saved account also unlocks the client-closed view.
  const accountSaved = !!(cfg.riotId && cfg.region);

  // Prefer the live LCU when the client is open; otherwise use the linked Riot
  // account via the official API so stats still show with the client closed.
  let summary = null;
  try {
    summary = await getCurrentSummary();
  } catch (_) {
    summary = null;
  }

  const key = cfg.anthropicApiKey;
  const hasAiKey = hasValidAiKey(key);
  return {
    needsSetup: !accountSaved && !cfg.riotSkipped,
    configured,
    hasAccount: accountSaved,
    cached: !!(summary && summary.cached), // showing a saved snapshot (client closed, no key)
    hasAiKey, // gates every AI feature in the UI — hidden until the user adds a key
    summary,
    status: { clientUp, phase: clientPhase },
    settings: {
      anthropicApiKey: hasAiKey ? key : "",
      hasAiKey,
      baselineApiUrl: cfg.baselineApiUrl || "",
      coachUseClaude: cfg.coachUseClaude === true,
      overlayDefaultDesign: cfg.overlayDefaultDesign === true,
      matchCount: typeof cfg.matchCount === "number" ? cfg.matchCount : 20,
      riotId: cfg.riotId || "",
      region: cfg.region || "",
      hasRiotKey: !!cfg.riotApiKey,
    },
    lastMatch: lastSnapshot,
    history: rankProgress.history(app.getPath("userData")),
    theme: resolveTheme(),
  };
}

// A Claude API key is "valid" when it's a non-empty string that isn't the
// `sk-ant-...` placeholder shipped in config.example.json. We never bake in or
// assume a key — the user supplies their own.
function hasValidAiKey(key) {
  return !!(key && typeof key === "string" && key.trim() && !key.startsWith("sk-ant-..."));
}

// Single source of truth for whether the AI features run. They are gated purely
// on the user having added their OWN Claude API key: no key -> every AI feature
// is hidden (see hasAiKey in buildHomeData); a valid key -> AI is enabled and
// every request goes to Claude with that key. There is no baked-in/assumed key.
function useClaudeAI() {
  let cfg = {};
  try { cfg = loadConfig(); } catch (_) { cfg = {}; }
  return hasValidAiKey(cfg && cfg.anthropicApiKey);
}

// The built-in advisor needs no key, so the AI features are always ready. This
// only reports "not ready" when the user has opted into Claude but the key is
// missing/invalid — in which case we tell them how to fix it.
function coachConfigStatus() {
  let cfg = {};
  try {
    cfg = loadConfig();
  } catch (_) {
    cfg = {};
  }
  if (!hasValidAiKey(cfg.anthropicApiKey)) {
    return {
      ready: false,
      message: "AI review needs your own Claude API key — add it in Settings to enable AI features.",
    };
  }
  return { ready: true, message: "" };
}

function buildCoachPayload(s, replay) {
  if (!s) return "No match data was captured this game.";
  const timeline = (s.events || [])
    .filter((e) => e.EventName === "ChampionKill")
    .map(
      (e) =>
        `- ${Math.floor(e.EventTime / 60)}:${String(Math.floor(e.EventTime % 60)).padStart(2, "0")} ChampionKill`
    )
    .join("\n");
  const awards = (s.awards || []).map((a) => `- ${a.label}: ${a.desc}`).join("\n");
  return [
    "# Post-match data (my own game)",
    `- Champion: ${s.champion}`,
    `- Duration: ${Math.floor(s.gameTime / 60)} min`,
    `- KDA: ${s.kda.k}/${s.kda.d}/${s.kda.a}`,
    `- CS: ${Math.round(s.cs)} (${s.csPerMin.toFixed(1)} / min)`,
    `- Gold: ${Math.round(s.gold)}`,
    replay ? `- Replay file: ${replay.name}` : "",
    "",
    awards ? "## Performance badges earned\n" + awards : "",
    "## Kill-event timeline (this match)",
    timeline || "(no kill events recorded)",
  ]
    .filter(Boolean)
    .join("\n");
}

async function streamCoach(sender) {
  const send = (ch, v) => {
    if (sender && !sender.isDestroyed()) sender.send(ch, v);
  };

  const status = coachConfigStatus();
  if (!status.ready) {
    send("coach-error", status.message);
    return;
  }

  // Free, built-in engine by default — no tokens, no cost. We "stream" the
  // generated review in small slices so the post-game window keeps its live feel.
  if (!useClaudeAI()) {
    if (!lastSnapshot) {
      send("coach-error", "No match data captured yet — finish a game with PepStats running.");
      return;
    }
    const review = advisor.matchReview(lastSnapshot);
    const chunks = review.match(/[^]{1,48}/g) || [review];
    for (const c of chunks) send("coach-chunk", c);
    send("coach-done", {});
    return;
  }

  const cfg = loadConfig();

  // Prefer a deep, death-by-death review from the user's own match timeline
  // (official match-v5). Best-effort: if the match isn't indexed yet or the
  // account isn't linked, fall back to the lightweight snapshot payload.
  let system = COACH_SYSTEM;
  let userContent = buildCoachPayload(lastSnapshot, lastReplay);
  try {
    const account = { riotId: cfg.riotId, region: cfg.region, riotApiKey: cfg.riotApiKey };
    const deep = await deepCoach.buildTimelineReview(account);
    if (deep) {
      system = DEEP_COACH_SYSTEM;
      userContent = deep;
    }
  } catch (_) { /* fall back to the snapshot payload */ }

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": cfg.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.coachModel || "claude-sonnet-4-6",
        max_tokens: 1024,
        stream: true,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userContent }],
      }),
    });
  } catch (e) {
    send("coach-error", "Coach request failed: " + e.message);
    return;
  }

  if (!res.ok) {
    let detail = String(res.status);
    try {
      const j = await res.json();
      detail = (j.error && j.error.message) || detail;
    } catch (_) {
      /* keep status */
    }
    send("coach-error", "Coach error: " + detail);
    return;
  }

  // Parse the Anthropic SSE stream line-by-line; forward each text delta.
  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const ev = JSON.parse(data);
          if (ev.type === "content_block_delta" && ev.delta && typeof ev.delta.text === "string") {
            send("coach-chunk", ev.delta.text);
          }
        } catch (_) {
          /* keepalive / partial line — ignore */
        }
      }
    }
    send("coach-done", {});
  } catch (e) {
    send("coach-error", "Coach stream interrupted: " + e.message);
  }
}

// ----- IPC ---------------------------------------------------------------
ipcMain.on("coach-start", (e) => streamCoach(e.sender));
// Live CS differential vs lane opponent (read-only Live Client telemetry).
ipcMain.handle("get-live-csd", () => liveTelemetry.get());
ipcMain.handle("get-last-game", () => ({ scores: lastSnapshot, replay: lastReplay, coach: coachConfigStatus() }));
ipcMain.handle("get-postgame", async () => {
  try {
    const cfg = loadConfig();
    const account = { riotId: cfg.riotId, region: cfg.region, riotApiKey: cfg.riotApiKey };
    const data = await postgameEngine.analyze(account);
    return { ...data, replay: lastReplay, coach: coachConfigStatus() };
  } catch (e) {
    return { ok: false, error: e.message, replay: lastReplay, coach: coachConfigStatus() };
  }
});
ipcMain.handle("get-pregame", async () => {
  try {
    return await lcu.getChampSelectSession();
  } catch (_) {
    return null;
  }
});

// ----- Champ-select ally lookup ------------------------------------------
// Reads your own team's PUUIDs from the LCU champ-select session, then pulls
// each teammate's recent-5 win-rate + KDA from the OFFICIAL match-v5 API. All
// sanctioned: LCU read for the lobby roster + the public match API for form.
// Enemy identities are deliberately hidden by Riot in champ select, so this only
// ever resolves allies. Cached 60s by the teammate set so the pre-game window
// can poll freely without re-hitting the API.
let _alliesCache = { key: "", ts: 0, data: null };
async function getLobbyAllies() {
  const cfg = loadConfig();
  if (!(cfg.riotId && cfg.region && cfg.riotApiKey)) {
    return { ok: false, error: "Teammate recent-form needs the full Riot connection — coming with Riot Sign-On." };
  }

  let session = null;
  try {
    session = await lcu.getChampSelectSession();
  } catch (_) {
    session = null;
  }
  if (!session || !Array.isArray(session.myTeam)) return { ok: false, error: "Not in champ select." };

  const localCell = session.localPlayerCellId;
  const team = session.myTeam.filter((m) => m && m.puuid && m.cellId !== localCell);
  if (!team.length) return { ok: true, allies: [], note: "Teammates' identities aren't available yet." };

  const cacheKey = team.map((m) => m.puuid).sort().join(",");
  const now = Date.now();
  if (_alliesCache.key === cacheKey && now - _alliesCache.ts < 60000 && _alliesCache.data) {
    return _alliesCache.data;
  }

  const acc = { region: cfg.region, riotApiKey: cfg.riotApiKey };
  let idx = null;
  try { idx = await riotApi.championIndex(); } catch (_) {}

  const allies = [];
  let allyN = 0;
  for (const m of team) {
    let recent = null;
    try { recent = await riotApi.recentByPuuid(acc, m.puuid, 5); } catch (_) { recent = null; }
    const champ = idx && m.championId ? idx.byId[String(m.championId)] : null;
    allyN++;
    allies.push({
      cellId: m.cellId,
      position: (m.assignedPosition || "").toUpperCase(),
      championId: m.championId || 0,
      champion: champ ? champ.name : "",
      // Riot's champ-select anonymity rule: non-party summoner names must be
      // replaced with neutral designations during champion select. We anonymize
      // EVERY non-self ally (over-compliance is fine) — the form stats stay,
      // the identity does not.
      label: "Ally " + allyN,
      recent: recent
        ? { games: recent.games, wr: recent.wr, kda: recent.kda, k: recent.k, d: recent.d, a: recent.a, topChamp: recent.topChamp }
        : null,
    });
  }

  const data = { ok: true, allies };
  _alliesCache = { key: cacheKey, ts: now, data };
  return data;
}
ipcMain.handle("get-lobby-allies", () => getLobbyAllies());

// ----- Draft coach (curated counters + synergies) ------------------------
// Reads the live champ-select session, maps locked champions to Data Dragon
// keys, and asks the curated draftCoach engine for counters to enemy locks +
// synergies with ally locks. Curated data only — no scraping, no win-rate API.
async function getDraftAdvice() {
  let session = null;
  try { session = await lcu.getChampSelectSession(); } catch (_) { session = null; }
  if (!session || !Array.isArray(session.myTeam)) return { ok: false };

  let idx = null;
  try { idx = await riotApi.championIndex(); } catch (_) {}
  if (!idx || !idx.byId) return { ok: false };

  // Resolve numeric championId -> Data Dragon key, and key -> { name, icon }.
  const keyOf = (cid) => (cid && idx.byId[String(cid)] ? idx.byId[String(cid)].id : null);
  const byKey = {};
  for (const cid of Object.keys(idx.byId)) {
    const e = idx.byId[cid];
    if (e && e.id) byKey[e.id] = { name: e.name, ddId: e.id };
  }
  const decorate = (list) =>
    list.map((s) => ({
      key: s.key,
      name: (byKey[s.key] && byKey[s.key].name) || s.key,
      icon: idx.version ? `https://ddragon.leagueoflegends.com/cdn/${idx.version}/img/champion/${s.key}.png` : null,
      reason: s.reason,
      vs: (s.vs || []).map((k) => (byKey[k] && byKey[k].name) || k),
    }));

  const localCell = session.localPlayerCellId;
  const myTeam = session.myTeam || [];
  const theirTeam = session.theirTeam || [];

  const enemyKeys = theirTeam.map((m) => keyOf(m.championId)).filter(Boolean);
  const allyKeys = myTeam
    .filter((m) => m.cellId !== localCell)
    .map((m) => keyOf(m.championId))
    .filter(Boolean);

  const bans = (session.bans && [...(session.bans.myTeamBans || []), ...(session.bans.theirTeamBans || [])]) || [];
  const me = myTeam.find((m) => m.cellId === localCell);
  const myHover = me ? (me.championId || me.championPickIntent || 0) : 0;
  const takenKeys = [
    ...enemyKeys,
    ...allyKeys,
    ...bans.map(keyOf).filter(Boolean),
    keyOf(myHover),
  ].filter(Boolean);

  const advice = draftCoach.advise({ allyKeys, enemyKeys, takenKeys });
  return { ok: true, counters: decorate(advice.counters), synergies: decorate(advice.synergies) };
}
ipcMain.handle("get-draft-advice", () => getDraftAdvice().catch((e) => ({ ok: false, error: e.message })));

// Home / client window
ipcMain.handle("get-home", () => buildHomeData());
ipcMain.handle("home-predict", () => predictRankUp());
ipcMain.handle("home-champs", () => champAdvice());
ipcMain.handle("save-settings", (_e, s) => {
  const patch = {};
  // The Settings field is pre-filled with the current key, so an empty submit is
  // a deliberate "remove my key" — honor it (the user can clear AI access), and
  // store a non-empty value as the new key.
  if (s && typeof s.anthropicApiKey === "string") patch.anthropicApiKey = s.anthropicApiKey.trim();
  if (s && typeof s.baselineApiUrl === "string") patch.baselineApiUrl = s.baselineApiUrl;
  if (s && typeof s.coachUseClaude === "boolean") patch.coachUseClaude = s.coachUseClaude;
  if (s && typeof s.overlayDefaultDesign === "boolean") patch.overlayDefaultDesign = s.overlayDefaultDesign;
  if (s && typeof s.matchCount === "number" && s.matchCount > 0) patch.matchCount = Math.min(50, Math.max(5, Math.round(s.matchCount)));
  try {
    saveConfig(patch);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("get-theme", () => resolveTheme());
ipcMain.handle("save-theme", (_e, patch) => {
  const cur = resolveTheme();
  const p = patch || {};
  const merged = {
    ...cur,
    ...p,
    overlay: {
      ...cur.overlay,
      ...(p.overlay || {}),
      rows: { ...cur.overlay.rows, ...((p.overlay && p.overlay.rows) || {}) },
      modules: { ...cur.overlay.modules, ...((p.overlay && p.overlay.modules) || {}) },
    },
  };
  saveConfig({ ui: merged });
  broadcastTheme();
  return resolveTheme();
});

ipcMain.handle("get-champions", () => riotApi.championIndex());

// Curated, situational multi-build for a champion (numeric championId). Returns
// every variant (Standard Core / vs Heavy AP / vs Heavy AD) with icon URLs.
ipcMain.handle("get-build", async (_e, championId) => {
  try {
    const idx = await riotApi.championIndex();
    const champ = idx.byId[String(championId)];
    if (!champ) return null;
    const set = builds.getVariants(champ.id);
    if (!set) return { champion: champ.name, none: true };
    const ver = idx.version;
    const rm = await riotApi.perkMaps();
    const perk = (id) => (rm.perks && rm.perks[id]) || null;
    const style = (id) => (rm.styles && rm.styles[id]) || null;
    const spell = (id) => (builds.SUMMONER_SPELLS[id] ? `https://ddragon.leagueoflegends.com/cdn/${ver}/img/spell/${builds.SUMMONER_SPELLS[id]}.png` : null);
    const item = (id) => `https://ddragon.leagueoflegends.com/cdn/${ver}/img/item/${id}.png`;
    const resolve = (b) => {
      const ids = b.runes.ids;
      return {
        role: b.role,
        runes: {
          primary: style(b.runes.primary), sub: style(b.runes.sub),
          keystone: perk(ids[0]), perks: [perk(ids[1]), perk(ids[2]), perk(ids[3])], sec: [perk(ids[4]), perk(ids[5])],
        },
        spells: b.spells.map(spell),
        skills: b.skills,
        start: b.start.map(item),
        core: b.core.map(item),
      };
    };
    const variants = {};
    for (const name of set.order) variants[name] = resolve(set.variants[name]);
    return { champion: champ.name, role: set.variants[set.order[0]].role, order: set.order, variants };
  } catch (e) {
    return { error: e.message };
  }
});

// Import the rune page for the chosen variant into the client via the LCU.
ipcMain.handle("import-runes", async (_e, championId, variantName) => {
  try {
    const idx = await riotApi.championIndex();
    const champ = idx.byId[String(championId)];
    const set = champ && builds.getVariants(champ.id);
    if (!set) return { ok: false, error: "No curated build for this champion yet." };
    const b = set.variants[variantName] || set.variants[set.order[0]];
    const label = variantName && set.variants[variantName] ? variantName : set.order[0];
    await lcu.importRunePage({
      name: `PepStats: ${champ.name} — ${label}`,
      primaryStyleId: b.runes.primary,
      subStyleId: b.runes.sub,
      selectedPerkIds: b.runes.ids,
    });

    // Also push an item set for the same variant (best-effort — never fail the
    // rune import if item sets are disabled/unavailable on the client).
    let items = false;
    try {
      const block = (type, ids) => ({ type, items: (ids || []).filter(Boolean).map((id) => ({ id: String(id), count: 1 })) });
      await lcu.importItemSet({
        championId: Number(championId) || 0,
        title: `PepStats: ${champ.name} — ${label}`,
        blocks: [block("Starting", b.start), block("Core build", b.core)],
      });
      items = true;
    } catch (_) { /* item set import is optional */ }

    return { ok: true, name: champ.name, variant: label, items };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// Curated build looked up by Data Dragon champion key (e.g. "Jinx") rather than
// numeric id — used by the analytics panel for skill order / item path.
ipcMain.handle("get-build-key", async (_e, champKey) => {
  try {
    const set = builds.getVariants(champKey);
    // Derive the real skill order from the user's games (falls back to curated).
    const cfg = loadConfig();
    const account = { riotId: cfg.riotId, region: cfg.region, riotApiKey: cfg.riotApiKey };
    const derived = await buildDataEngine.getOrDeriveSkillOrder(champKey, account);
    if (!set && !derived) return null;
    const ver = await riotApi.ddragonVersion();
    const item = (id) => `https://ddragon.leagueoflegends.com/cdn/${ver}/img/item/${id}.png`;
    const std = set ? set.variants[set.order[0]] : null;
    return {
      key: champKey,
      role: std ? std.role : "",
      skills: (derived && derived.skillMaxOrder) || (std ? std.skills : []),
      skillPath: derived ? derived.skillPath : null,
      source: derived ? derived.source : "curated",
      start: std ? std.start.map(item) : [],
      core: std ? std.core.map(item) : [],
    };
  } catch (e) {
    return null;
  }
});

// TFT history: Riot key when present; otherwise the running client serves the
// player's own TFT history locally (keyless out-of-box path).
async function fetchTftMatches(count) {
  const cfg = loadConfig();
  if (cfg.riotId && cfg.region && cfg.riotApiKey) {
    return tftEngine.getMatches({ riotId: cfg.riotId, region: cfg.region, riotApiKey: cfg.riotApiKey }, count);
  }
  if (!clientUp) return { ok: false, error: "link" };
  try {
    return { ok: true, partial: true, source: "lcu", matches: await lcuHistory.tftMatches(count) };
  } catch (_) {
    return { ok: false, error: "Couldn't read TFT history from the client — is it fully logged in?" };
  }
}
ipcMain.handle("get-tft-matches", (_e, count) => fetchTftMatches(count || 10));
// Deep TFT analytics: fetch history then run the local analytics engine.
ipcMain.handle("get-tft-analytics", async (_e, count) => {
  const res = await fetchTftMatches(count || 20);
  if (!res.ok) return res; // propagate tft-access / link / error
  return { ...res, analytics: tftAnalytics.analyze(res.matches) };
});
// Ranked TFT entry: official tft-league-v1 with a key, else the client's own
// current-ranked-stats (both read-only).
ipcMain.handle("get-tft-rank", async () => {
  const cfg = loadConfig();
  try {
    if (cfg.riotId && cfg.region && cfg.riotApiKey) {
      return await riotApi.tftRank({ riotId: cfg.riotId, region: cfg.region, riotApiKey: cfg.riotApiKey });
    }
    if (clientUp) return await lcuHistory.tftRankLcu();
    return null;
  } catch (_) { return null; }
});
// Static item-recipe table from CommunityDragon (per-patch, never live data).
ipcMain.handle("get-tft-recipes", async () => {
  try { return await riotApi.tftRecipes(); }
  catch (e) { return { error: e.message }; }
});
// Current set's trait breakpoints (same static CDN source, never live).
ipcMain.handle("get-tft-traits", async () => {
  try { return await riotApi.tftTraits(); }
  catch (e) { return { error: e.message }; }
});
// Current set's champion roster, for the manual comp planner (static).
ipcMain.handle("get-tft-champions", async () => {
  try { return await riotApi.tftChampions(); }
  catch (e) { return { error: e.message }; }
});

// Friends tracking (LCU presence + official Riot match digest).
ipcMain.handle("get-friends", () => friendsEngine.getFriends());
ipcMain.handle("get-friend-detail", async (_e, puuid) => {
  const cfg = loadConfig();
  const account = { riotId: cfg.riotId, region: cfg.region, riotApiKey: cfg.riotApiKey };
  const [digest, profile] = await Promise.all([
    friendsEngine.friendDigest(puuid, account).catch(() => null),
    friendsEngine.friendProfile(puuid, account).catch(() => null),
  ]);
  return { ok: !!(digest || profile), digest, profile };
});
// Live spectate (draft only) — fetched lazily when the user hits "Watch Live".
ipcMain.handle("get-friend-live", async (_e, puuid) => {
  const cfg = loadConfig();
  const account = { riotId: cfg.riotId, region: cfg.region, riotApiKey: cfg.riotApiKey };
  return friendsEngine.friendLiveGame(puuid, account);
});

ipcMain.handle("match-filters", () => riotApi.filterList());
// Dropdown filter -> queue ids, for filtering LCU-sourced rows locally (the
// Riot-key path filters server-side via match-v5 params instead).
const LOCAL_QUEUE_FILTER = {
  ranked: [420], flex: [440], normal: [400, 430, 490], aram: [450], arena: [1700, 1710],
};

// Champion performance + "last N" summary from a match-row array. Shared by the
// Riot-key and keyless LCU paths (remakes excluded from both).
function aggregateMatches(matches) {
  const champs = {};
  let w = 0, l = 0, games = 0, kS = 0, dS = 0, aS = 0;
  for (const m of matches) {
    if (m.remake) continue;
    games++; m.win ? w++ : l++; kS += m.k; dS += m.d; aS += m.a;
    const c = champs[m.champion] || (champs[m.champion] = { champion: m.champion, champKey: m.champKey, games: 0, wins: 0, k: 0, d: 0, a: 0 });
    c.games++; if (m.win) c.wins++; c.k += m.k; c.d += m.d; c.a += m.a;
  }
  const champList = Object.values(champs)
    .map((c) => ({ champion: c.champion, champKey: c.champKey, games: c.games, wins: c.wins, wr: Math.round((c.wins / c.games) * 100), kda: c.d ? +(((c.k + c.a) / c.d).toFixed(2)) : c.k + c.a }))
    .sort((a, b) => b.games - a.games).slice(0, 6);
  const summary = { w, l, games, kda: dS ? +(((kS + aS) / dS).toFixed(2)) : kS + aS, avgK: games ? +(kS / games).toFixed(1) : 0, avgD: games ? +(dS / games).toFixed(1) : 0, avgA: games ? +(aS / games).toFixed(1) : 0 };
  return { champs: champList, summary };
}

ipcMain.handle("get-matches", async (_e, filter, count) => {
  const cfg = loadConfig();
  const hasKey = !!(cfg.riotId && cfg.region && cfg.riotApiKey);
  // Keyless out-of-box path: the running client serves the player's own match
  // history locally (rows marked partial — no KP%/team-damage without the full
  // lobby, which only match-v5 provides).
  if (!hasKey) {
    if (!clientUp) return { ok: false, error: "Open the League client to see matches." };
    try {
      let matches = await lcuHistory.lolMatches(count || 20);
      const want = LOCAL_QUEUE_FILTER[filter];
      if (want) matches = matches.filter((m) => want.includes(m.queueId));
      const version = await riotApi.ddragonVersion();
      let runes = null; try { runes = await riotApi.perkMaps(); } catch (_) {}
      return { ok: true, partial: true, source: "lcu", matches, ...aggregateMatches(matches), version, runes };
    } catch (e) {
      return { ok: false, error: "Couldn't read match history from the client — is it fully logged in?" };
    }
  }
  try {
    const account = { riotId: cfg.riotId, region: cfg.region, riotApiKey: cfg.riotApiKey };
    const matches = await riotApi.getMatches(account, filter || "all", count || 20);
    const version = await riotApi.ddragonVersion();
    const runes = await riotApi.perkMaps();

    return { ok: true, matches, ...aggregateMatches(matches), version, runes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Export the currently loaded match list to a CSV the user picks a path for.
ipcMain.handle("export-matches", async (e, payload) => {
  const matches = (payload && payload.matches) || [];
  if (!matches.length) return { ok: false, error: "No matches to export." };

  const csvCell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const cols = ["Date", "Queue", "Champion", "Result", "K", "D", "A", "KDA", "CS", "CS/min", "KP%", "Vision", "Damage", "Position", "Duration(min)"];
  const rows = matches.map((m) => [
    m.endTs ? new Date(m.endTs).toISOString().slice(0, 10) : "",
    m.queue || "",
    m.champion || "",
    m.remake ? "Remake" : (m.win ? "Win" : "Loss"),
    m.k, m.d, m.a, m.kda, m.cs, m.csPerMin, m.kp, m.vision, m.dmg,
    m.position || "",
    m.durationSec ? Math.round(m.durationSec / 60) : "",
  ]);
  const csv = [cols, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");

  const win = BrowserWindow.fromWebContents(e.sender);
  const suggested = `pepstats-matches-${(payload && payload.filter) || "all"}.csv`;
  const res = await dialog.showSaveDialog(win, {
    title: "Export match history",
    defaultPath: suggested,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, "﻿" + csv, "utf8"); // BOM => Excel opens UTF-8 cleanly
    return { ok: true, path: res.filePath, count: matches.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// App info: version + current OS launch-on-startup state.
ipcMain.handle("get-app-info", () => {
  let startup = false;
  try { startup = !!app.getLoginItemSettings().openAtLogin; } catch (_) {}
  return { version: app.getVersion(), startup };
});
ipcMain.handle("set-startup", (_e, on) => {
  // Edge case B: registry/login-item writes can be blocked by UAC, group
  // policy, or an unsigned/sandboxed environment. Never let that bubble up and
  // crash the background loop — catch it, log it, and report failure cleanly.
  try {
    app.setLoginItemSettings({ openAtLogin: !!on });
    return { success: true, ok: true };
  } catch (e) {
    console.error("[startup] Failed to set launch-on-startup:", e && e.message ? e.message : e);
    return { success: false, ok: false, error: (e && e.message) || "Could not update startup setting." };
  }
});
ipcMain.handle("clear-match-cache", () => {
  try { riotApi.clearCache(); buildDataEngine.clearCache(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("open-data-folder", () => {
  try { shell.openPath(app.getPath("userData")); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("open-repo", () => {
  try { shell.openExternal("https://github.com/KPScriptz/pepstats"); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("riot-regions", () => riotApi.regionList());
ipcMain.handle("connect-riot", async (_e, s) => {
  const cfg = {
    riotId: (s && s.riotId || "").trim(),
    region: (s && s.region || "").trim().toUpperCase(),
    riotApiKey: (s && s.riotApiKey || "").trim(),
  };
  try {
    // Validate by actually fetching the profile before saving.
    const profile = await riotApi.fetchProfile(cfg);
    saveConfig({ ...cfg, riotSkipped: false });
    accountRank = null; // re-resolve baseline rank against the linked account
    // The match cache is keyed by matchId only and stores the *linked PUUID's*
    // perspective (win/KDA/items), so a new account must start from a clean cache
    // or it would show the previous account's stats for any shared match.
    try { riotApi.clearCache(); } catch (_) {}
    return { ok: true, name: profile.summoner.name, tag: profile.summoner.tagLine };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("skip-riot", () => {
  saveConfig({ riotSkipped: true });
  return { ok: true };
});

// Probe the running client for the signed-in account (used by the setup screen to
// offer one-click connect + pre-fill the fields). { available, riotId, region, name }.
ipcMain.handle("client-account", async () => {
  if (!clientUp) return { available: false };
  try {
    const acc = await lcu.account();
    if (!acc || !acc.gameName) return { available: false };
    return {
      available: true,
      name: acc.gameName,
      riotId: acc.tagLine ? acc.gameName + "#" + acc.tagLine : acc.gameName,
      region: riotApi.platformToRegion(acc.region),
    };
  } catch (_) {
    return { available: false };
  }
});

// Connect by simply having League open: read the account from the client and save
// it (Riot ID + region + puuid, no key required). The app then works live while the
// client is open, and shows the saved snapshot when it's closed.
ipcMain.handle("connect-client", async () => {
  if (!clientUp) return { ok: false, error: "Open the League client first, then try again." };
  try {
    const acc = await lcu.account();
    if (!acc || !acc.gameName) return { ok: false, error: "Couldn't read your account from the League client." };
    const riotId = acc.tagLine ? acc.gameName + "#" + acc.tagLine : acc.gameName;
    const region = riotApi.platformToRegion(acc.region) || (loadConfig().region || "");
    // A saved account needs a region (buildHomeData treats riotId+region as
    // "set up"). Saving "" would leave the user half-connected on the setup
    // screen forever — fail loudly with a fix instead.
    if (!region) return { ok: false, error: "Couldn't detect your region from the client — pick it below and connect manually." };
    saveConfig({ riotId, region, puuid: acc.puuid || "", riotSkipped: false });
    accountRank = null;
    try { riotApi.clearCache(); } catch (_) {}
    return { ok: true, name: acc.gameName, riotId, region };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.on("overlay-reposition", () => setDesignMode(true));
ipcMain.on("open-review", () => {
  // Reachable mid-game (Ctrl+Shift+H shows home over the overlay). Leaving
  // INGAME through this side door must stop the live-match engines — otherwise
  // the poll loop's postgame branch never fires and they run until app quit.
  if (appState === STATE.INGAME) {
    liveTelemetry.stop();
    sawLiveGame = false;
  }
  ensure("postgame");
  showOnly("postgame");
  appState = STATE.POSTGAME;
  sendTo("postgame", "last-game", { scores: lastSnapshot, replay: lastReplay, coach: coachConfigStatus() });
});

// Frameless window controls (act on the window that sent the message)
ipcMain.on("win-min", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.minimize();
});
ipcMain.on("win-close", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  // Closing the home client quits PepStats (it's the primary window); other
  // frameless dashboards just hide back to the home client.
  if (w === windows.home) app.quit();
  else if (w) w.hide();
});

// ----- Lifecycle ---------------------------------------------------------
app.whenReady().then(() => {
  if (process.platform === "win32") app.setAppUserModelId("com.kylepeper.pepstats");

  // Persist the match-detail cache across sessions (cuts Riot API calls).
  riotApi.setCacheDir(app.getPath("userData"));
  // Warm the item-gold map for the live gold-value diff (best-effort).
  riotApi.itemGold().then((m) => { itemGoldMap = m; }).catch(() => {});

  ensure("ingame");
  // Default to Live (click-through) mode and keep the overlay hidden until a
  // match is live — it surfaces automatically from poll()'s in-game branch.
  // Press Ctrl+Shift+D any time to enter Design Mode and reposition it. The
  // user can opt to start in Design mode from Settings → General.
  let startDesign = false;
  try { startDesign = loadConfig().overlayDefaultDesign === true; } catch (_) {}
  setDesignMode(startDesign);

  // The home/client window is the app's default taskbar presence out of game.
  showHome();

  globalShortcut.register("CommandOrControl+Shift+D", () => setDesignMode(!designMode));
  globalShortcut.register("CommandOrControl+Shift+1", () => showOnly("pregame"));
  globalShortcut.register("CommandOrControl+Shift+2", () => showOnly("ingame"));
  globalShortcut.register("CommandOrControl+Shift+3", () => showOnly("postgame"));
  globalShortcut.register("CommandOrControl+Shift+H", () => showHome());
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());

  lcu.init();           // resolve the (possibly non-default) install dir
  startLcuSocket();
  pollProcess();
  setInterval(pollProcess, PROC_POLL_MS);
  setInterval(poll, POLL_MS);
  poll();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (lcuSocket) lcuSocket.stop();
});
app.on("window-all-closed", () => app.quit());
