"use strict";

const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const liveClient = require("./shared/liveClient");
const lcu = require("./shared/lcu");
const { LcuSocket } = require("./shared/lcuSocket");
const { computeTimers } = require("./shared/timers");
const rankBaseline = require("./shared/rankBaseline");
const processWatch = require("./shared/process");
const replays = require("./shared/replays");

// ----- Tunables ----------------------------------------------------------
const POLL_MS = 1000;          // live-game heartbeat (1 Hz)
const LIVE_TIMEOUT_MS = 800;   // tight enough to never lag the poll, loose
                               // enough not to flap on a busy machine
const PROC_POLL_MS = 5000;     // process watcher cadence (low overhead)

// ----- App state machine -------------------------------------------------
// idle -> pregame (champ select) -> ingame (match live) -> postgame (match ended)
const STATE = { IDLE: "idle", PREGAME: "pregame", INGAME: "ingame", POSTGAME: "postgame" };

const windows = { ingame: null, pregame: null, postgame: null };
let appState = STATE.IDLE;
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

function createDashboard(file, role) {
  const win = new BrowserWindow({
    width: 1000,
    height: 660,
    show: false,
    frame: false,
    backgroundColor: "#12141a",
    resizable: true,
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
  return windows[role];
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
    if (appState === STATE.PREGAME) appState = STATE.IDLE;
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
    sawLiveGame = false;
    return;
  }

  // Otherwise, if the client is up, check for champ select via polling. The LCU
  // socket pushes updates too; this is the resilient fallback.
  if (!clientUp) return;
  let phase = "None";
  try {
    phase = await lcu.getGameflowPhase();
  } catch (_) {
    phase = "None";
  }
  if (phase === "ChampSelect" && appState !== STATE.PREGAME) {
    appState = STATE.PREGAME;
    ensure("pregame");
    showOnly("pregame");
  }
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
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (_) {
      /* try next */
    }
  }
  return {};
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

// ----- Lifecycle ---------------------------------------------------------
app.whenReady().then(() => {
  ensure("ingame");
  // Default to Live (click-through) mode and keep the overlay hidden until a
  // match is live — it surfaces automatically from poll()'s in-game branch.
  // Press Ctrl+Shift+D any time to enter Design Mode and reposition it.
  setDesignMode(false);

  globalShortcut.register("CommandOrControl+Shift+D", () => setDesignMode(!designMode));
  globalShortcut.register("CommandOrControl+Shift+1", () => showOnly("pregame"));
  globalShortcut.register("CommandOrControl+Shift+2", () => showOnly("ingame"));
  globalShortcut.register("CommandOrControl+Shift+3", () => showOnly("postgame"));
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
