"use strict";

const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const liveClient = require("./shared/liveClient");
const lcu = require("./shared/lcu");
const { LcuSocket } = require("./shared/lcuSocket");
const { computeTimers } = require("./shared/timers");
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

// ----- Window factories --------------------------------------------------
function preload() {
  return path.join(__dirname, "preload.js");
}

// Engine 3: transparent, click-through overlay over Borderless League.
// NOTE: app.disableHardwareAcceleration() is intentionally NOT called, so the
// GPU keeps compositing the overlay for ~0% in-game FPS impact.
function createOverlay() {
  const win = new BrowserWindow({
    width: 240,
    height: 360,
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
  win.setPosition(area.x + area.width - 240 - 20, area.y + 20);
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
  const w = windows.ingame;
  if (!w || w.isDestroyed()) return;
  if (on) {
    // Design Mode: capture the mouse so the HUD can be dragged/repositioned.
    w.setIgnoreMouseEvents(false);
  } else {
    // Live Mode: absolute click-through — zero gameplay mouse interception.
    w.setIgnoreMouseEvents(true, { forward: true });
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
    const timers = computeTimers(scores.gameTime, scores.events);
    if (appState !== STATE.INGAME) {
      appState = STATE.INGAME;
      ensure("ingame");
      showOnly("ingame");
      setDesignMode(false); // matches go live (click-through) by default
    }
    sendTo("ingame", "overlay", { scores, timers, mode: designMode ? "design" : "live" });
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
    sendTo("postgame", "last-game", { scores: lastSnapshot, replay: lastReplay });
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

  const cfg = loadConfig();
  if (!cfg.anthropicApiKey || cfg.anthropicApiKey.startsWith("sk-ant-...")) {
    send("coach-error", "Add your Anthropic API key to config.json to enable the AI coach.");
    return;
  }

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
ipcMain.handle("get-last-game", () => ({ scores: lastSnapshot, replay: lastReplay }));
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
  setDesignMode(true); // start placeable so the user can position the overlay
  windows.ingame.show();

  globalShortcut.register("CommandOrControl+Shift+D", () => setDesignMode(!designMode));
  globalShortcut.register("CommandOrControl+Shift+1", () => showOnly("pregame"));
  globalShortcut.register("CommandOrControl+Shift+2", () => showOnly("ingame"));
  globalShortcut.register("CommandOrControl+Shift+3", () => showOnly("postgame"));
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());

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
