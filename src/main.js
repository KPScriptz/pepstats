"use strict";

const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const liveClient = require("./shared/liveClient");
const lcu = require("./shared/lcu");
const { computeTimers } = require("./shared/timers");

// ----- App state machine -------------------------------------------------
// idle -> pregame (champ select) -> ingame (match live) -> postgame (match ended)
const STATE = { IDLE: "idle", PREGAME: "pregame", INGAME: "ingame", POSTGAME: "postgame" };

const windows = { ingame: null, pregame: null, postgame: null };
let appState = STATE.IDLE;
let designMode = false;
let lastSnapshot = null; // most recent live-game data, for the post-game coach
let sawLiveGame = false;

// ----- Window factories --------------------------------------------------
function preload() {
  return path.join(__dirname, "preload.js");
}

function createOverlay() {
  const win = new BrowserWindow({
    width: 240,
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

// ----- Overlay design / live mode ---------------------------------------
function setDesignMode(on) {
  designMode = on;
  const w = windows.ingame;
  if (!w || w.isDestroyed()) return;
  if (on) w.setIgnoreMouseEvents(false);
  else w.setIgnoreMouseEvents(true, { forward: true });
  w.webContents.send("mode-change", on ? "design" : "live");
}

// ----- Phase detection loop ---------------------------------------------
async function poll() {
  let live = null;
  try {
    live = await liveClient.getAllGameData();
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
    const w = windows.ingame;
    if (w && !w.isDestroyed()) {
      w.webContents.send("overlay", { scores, timers, mode: designMode ? "design" : "live" });
    }
    return;
  }

  // No live game. Was one just running? -> post-game.
  if (sawLiveGame && appState === STATE.INGAME) {
    appState = STATE.POSTGAME;
    ensure("postgame");
    showOnly("postgame");
    sawLiveGame = false;
    return;
  }

  // Otherwise check the client for champ select (gray-area LCU).
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

// ----- Post-game AI coach (your own match data only) --------------------
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

function buildCoachPayload(s) {
  if (!s) return "No match data was captured this game.";
  const deaths = s.events
    .filter((e) => e.EventName === "ChampionKill")
    .map((e) => `- ${Math.floor(e.EventTime / 60)}:${String(Math.floor(e.EventTime % 60)).padStart(2, "0")} ${e.EventName}`)
    .join("\n");
  return [
    "# Post-match data (my own game)",
    `- Champion: ${s.champion}`,
    `- Duration: ${Math.floor(s.gameTime / 60)} min`,
    `- KDA: ${s.kda.k}/${s.kda.d}/${s.kda.a}`,
    `- CS: ${Math.round(s.cs)} (${s.csPerMin.toFixed(1)} / min)`,
    `- Gold: ${Math.round(s.gold)}`,
    "",
    "## Event timeline",
    deaths || "(no kill events recorded)",
  ].join("\n");
}

async function requestCoach() {
  const cfg = loadConfig();
  if (!cfg.anthropicApiKey || cfg.anthropicApiKey.startsWith("sk-ant-...")) {
    return { ok: false, text: "Add your Anthropic API key to config.json to enable the AI coach." };
  }
  const payload = buildCoachPayload(lastSnapshot);
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
        max_tokens: 1024,
        system: [
          {
            type: "text",
            text: "You are a Challenger-level League of Legends coach. Given a player's own post-match data, give a concise Tactical Post-Match Review: 3-5 macro takeaways (wave management, recall timing, objective routing) with specific, actionable fixes. Be direct and kind.",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: payload }],
      }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, text: "Coach error: " + (data.error?.message || res.status) };
    return { ok: true, text: (data.content && data.content[0] && data.content[0].text) || "(empty)" };
  } catch (e) {
    return { ok: false, text: "Coach request failed: " + e.message };
  }
}

// ----- IPC ---------------------------------------------------------------
ipcMain.handle("request-coach", requestCoach);
ipcMain.handle("get-last-game", () => lastSnapshot);
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

  setInterval(poll, 1000);
  poll();
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
