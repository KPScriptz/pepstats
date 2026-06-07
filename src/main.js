"use strict";

const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const liveClient = require("./shared/liveClient");
const lcu = require("./shared/lcu");
const { LcuSocket } = require("./shared/lcuSocket");
const { computeTimers } = require("./shared/timers");
const rankBaseline = require("./shared/rankBaseline");
const rankProgress = require("./shared/rankProgress");
const riotApi = require("./shared/riotApi");
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

// ----- Window factories --------------------------------------------------
function preload() {
  return path.join(__dirname, "preload.js");
}

// Engine 3: transparent, click-through overlay over Borderless League.
// NOTE: app.disableHardwareAcceleration() is intentionally NOT called, so the
// GPU keeps compositing the overlay for ~0% in-game FPS impact.
function createOverlay() {
  const win = new BrowserWindow({
    width: 220,
    height: 320,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    icon: ICON_PATH,
    webPreferences: { preload: preload(), contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const area = screen.getPrimaryDisplay().workArea;
  win.setPosition(area.x + area.width - 220 - 20, area.y + 20);
  win.loadFile(path.join(__dirname, "windows/ingame/index.html"));
  win.on("closed", () => (windows.ingame = null));
  return win;
}

function createDashboard(file, role, opts = {}) {
  const win = new BrowserWindow({
    width: opts.width || 1000,
    height: opts.height || 660,
    minWidth: opts.minWidth || 0,
    minHeight: opts.minHeight || 0,
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
    windows.postgame = createDashboard(path.join(__dirname, "windows/postgame/index.html"), "postgame");
  if (role === "home")
    windows.home = createDashboard(path.join(__dirname, "windows/home/index.html"), "home", {
      width: 880, height: 720, minWidth: 560, minHeight: 600,
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

// ----- Engine 2: phase-detection heartbeat -------------------------------
async function poll() {
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
    lastSnapshot = scores;

    // Resolve the rank baseline for this mode/role, then compare against it.
    const info = liveClient.gameInfo(live);
    const rank = await ensureRank();
    const role = liveClient.activeRole(live);
    const cfg = loadConfig();
    const baseline = await rankBaseline.getBaseline({
      tier: rank,
      role,
      mode: info.gameMode,
      apiUrl: cfg.baselineApiUrl,
    });
    const compare = liveClient.compareStats(live, baseline);
    const timers = computeTimers(scores.gameTime, scores.events, { isClassic: info.isClassic });
    if (appState !== STATE.INGAME) {
      appState = STATE.INGAME;
      ensure("ingame");
      showOnly("ingame");
      setDesignMode(false); // matches go live (click-through) by default
    }
    sendTo("ingame", "overlay", { scores, compare, timers, mode: designMode ? "design" : "live" });
    return;
  }

  // No live game. Was one just running? -> post-game.
  if (sawLiveGame && appState === STATE.INGAME) {
    appState = STATE.POSTGAME;
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
    if (appState === STATE.IDLE) ensure("home");
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
  "You are a Challenger-level League of Legends coach. Given a player's own " +
  "post-match data, give a concise Tactical Post-Match Review: 3-5 macro " +
  "takeaways (wave management, recall timing, objective routing) with specific, " +
  "actionable fixes. Be direct and kind.";

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

// ----- Theme / customization -------------------------------------------------
const THEME_DEFAULTS = {
  theme: "dark", // "dark" | "light"
  accent: "#36d6d6",
  density: "comfortable", // "comfortable" | "compact"
  fontScale: 1, // 0.9 .. 1.15
  overlay: {
    scale: 1, // 0.8 .. 1.3
    opacity: 1, // 0.5 .. 1
    rows: { csm: true, gpm: true, vision: true, kp: true, kda: true, lvl: true },
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
    overlay: {
      scale: num(ov.scale, 1, 0.8, 1.3),
      opacity: num(ov.opacity, 1, 0.4, 1),
      rows: { ...THEME_DEFAULTS.overlay.rows, ...(ov.rows || {}) },
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
  if (clientUp) return rankProgress.summary(lcu, app.getPath("userData"));
  if (riotCfg.riotId && riotCfg.region && riotCfg.riotApiKey) {
    const profile = await riotApi.fetchProfile(riotCfg);
    return rankProgress.buildSummary(app.getPath("userData"), profile.summoner, profile.ranked, "riot");
  }
  return null;
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
    "You are a League of Legends ranked-climb analyst. Given a player's rank, LP, " +
    "win rate and recent LP trend, estimate realistically how long it will take to " +
    "reach the next rank (and the next tier, e.g. Silver->Gold). Give a short, " +
    "concrete forecast: an estimated games/days range at their current win rate, the " +
    "win rate they'd need to climb faster, and one focus tip. Be encouraging but " +
    "honest. 4-6 sentences, no preamble.";

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

// Assemble everything the home/client window renders.
async function buildHomeData() {
  const cfg = loadConfig();
  const riotCfg = { riotId: cfg.riotId, region: cfg.region, riotApiKey: cfg.riotApiKey };
  const configured = !!(riotCfg.riotId && riotCfg.region && riotCfg.riotApiKey);

  // Prefer the live LCU when the client is open; otherwise use the linked Riot
  // account via the official API so stats still show with the client closed.
  let summary = null;
  try {
    summary = await getCurrentSummary();
  } catch (_) {
    summary = null;
  }

  const key = cfg.anthropicApiKey;
  return {
    needsSetup: !configured && !cfg.riotSkipped,
    configured,
    summary,
    status: { clientUp, phase: clientPhase },
    settings: {
      anthropicApiKey: key && !String(key).startsWith("sk-ant-...") ? key : "",
      baselineApiUrl: cfg.baselineApiUrl || "",
      riotId: cfg.riotId || "",
      region: cfg.region || "",
      hasRiotKey: !!cfg.riotApiKey,
    },
    lastMatch: lastSnapshot,
    history: rankProgress.history(app.getPath("userData")),
    theme: resolveTheme(),
  };
}

// Single source of truth for whether the Claude coach can run. Drives both the
// stream gate and the proactive post-game warning, so a missing config.json or
// absent API key degrades to a friendly banner instead of an unhandled error.
function coachConfigStatus() {
  let cfg = {};
  try {
    cfg = loadConfig();
  } catch (_) {
    cfg = {};
  }
  const key = cfg && cfg.anthropicApiKey;
  if (!key || typeof key !== "string" || key.startsWith("sk-ant-...")) {
    return {
      ready: false,
      message:
        "Claude coach unavailable — add your Anthropic API key to config.json to enable AI tactical reviews.",
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
  return [
    "# Post-match data (my own game)",
    `- Champion: ${s.champion}`,
    `- Duration: ${Math.floor(s.gameTime / 60)} min`,
    `- KDA: ${s.kda.k}/${s.kda.d}/${s.kda.a}`,
    `- CS: ${Math.round(s.cs)} (${s.csPerMin.toFixed(1)} / min)`,
    `- Gold: ${Math.round(s.gold)}`,
    replay ? `- Replay file: ${replay.name}` : "",
    "",
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
  const cfg = loadConfig();

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
        system: [{ type: "text", text: COACH_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: buildCoachPayload(lastSnapshot, lastReplay) }],
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
ipcMain.handle("get-last-game", () => ({ scores: lastSnapshot, replay: lastReplay, coach: coachConfigStatus() }));
ipcMain.handle("get-pregame", async () => {
  try {
    return await lcu.getChampSelectSession();
  } catch (_) {
    return null;
  }
});

// Home / client window
ipcMain.handle("get-home", () => buildHomeData());
ipcMain.handle("home-predict", () => predictRankUp());
ipcMain.handle("save-settings", (_e, s) => {
  const patch = {};
  if (s && typeof s.anthropicApiKey === "string") patch.anthropicApiKey = s.anthropicApiKey;
  if (s && typeof s.baselineApiUrl === "string") patch.baselineApiUrl = s.baselineApiUrl;
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
    },
  };
  saveConfig({ ui: merged });
  broadcastTheme();
  return resolveTheme();
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
    return { ok: true, name: profile.summoner.name, tag: profile.summoner.tagLine };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("skip-riot", () => {
  saveConfig({ riotSkipped: true });
  return { ok: true };
});
ipcMain.on("overlay-reposition", () => setDesignMode(true));
ipcMain.on("open-review", () => {
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

  ensure("ingame");
  // Default to Live (click-through) mode and keep the overlay hidden until a
  // match is live — it surfaces automatically from poll()'s in-game branch.
  // Press Ctrl+Shift+D any time to enter Design Mode and reposition it.
  setDesignMode(false);

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
