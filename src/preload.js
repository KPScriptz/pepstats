"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const role =
  (process.argv.find((a) => a.startsWith("--pepstats-role=")) || "").split("=")[1] || "ingame";

contextBridge.exposeInMainWorld("pepstats", {
  role,

  // In-game overlay
  onOverlay: (cb) => ipcRenderer.on("overlay", (_e, data) => cb(data)),
  onModeChange: (cb) => ipcRenderer.on("mode-change", (_e, mode) => cb(mode)),
  onForceDesignOff: (cb) => ipcRenderer.on("force-design-mode-off", () => cb()),
  onHighlight: (cb) => ipcRenderer.on("highlight", (_e, h) => cb(h)),
  onTrackerRoster: (cb) => ipcRenderer.on("tracker-roster", (_e, d) => cb(d)),
  onTrackerFire: (cb) => ipcRenderer.on("tracker-fire", (_e, d) => cb(d)),
  getLiveCsd: () => ipcRenderer.invoke("get-live-csd"),
  getCombatThreats: () => ipcRenderer.invoke("get-combat-threats"),
  getObjectiveAlert: () => ipcRenderer.invoke("get-objective-alert"),

  // Pre-game (poll + live push from the LCU socket)
  getPregame: () => ipcRenderer.invoke("get-pregame"),
  getChampions: () => ipcRenderer.invoke("get-champions"),
  getBuild: (championId) => ipcRenderer.invoke("get-build", championId),
  importRunes: (championId, variant) => ipcRenderer.invoke("import-runes", championId, variant),
  getLobbyAllies: () => ipcRenderer.invoke("get-lobby-allies"),
  getDraftAdvice: () => ipcRenderer.invoke("get-draft-advice"),
  onChampSelect: (cb) => ipcRenderer.on("champ-select", (_e, data) => cb(data)),

  // Post-game
  getLastGame: () => ipcRenderer.invoke("get-last-game"),
  getPostgame: () => ipcRenderer.invoke("get-postgame"),
  onLastGame: (cb) => ipcRenderer.on("last-game", (_e, data) => cb(data)),

  // Streaming AI coach
  startCoach: () => ipcRenderer.send("coach-start"),
  onCoachChunk: (cb) => ipcRenderer.on("coach-chunk", (_e, text) => cb(text)),
  onCoachDone: (cb) => ipcRenderer.on("coach-done", (_e, data) => cb(data)),
  onCoachError: (cb) => ipcRenderer.on("coach-error", (_e, msg) => cb(msg)),

  // Home / client window
  getHome: () => ipcRenderer.invoke("get-home"),
  onHome: (cb) => ipcRenderer.on("home-update", () => cb()),
  predictRankUp: () => ipcRenderer.invoke("home-predict"),
  suggestChamps: () => ipcRenderer.invoke("home-champs"),
  saveSettings: (s) => ipcRenderer.invoke("save-settings", s),

  // Match history
  getMatchFilters: () => ipcRenderer.invoke("match-filters"),
  getMatches: (filter, count) => ipcRenderer.invoke("get-matches", filter, count),
  getBuildByKey: (champKey) => ipcRenderer.invoke("get-build-key", champKey),
  exportMatches: (payload) => ipcRenderer.invoke("export-matches", payload),

  // TFT
  getTftMatches: (count) => ipcRenderer.invoke("get-tft-matches", count),
  getTftAnalytics: (count) => ipcRenderer.invoke("get-tft-analytics", count),

  // Friends tracking
  getFriends: () => ipcRenderer.invoke("get-friends"),
  getFriendDetail: (puuid) => ipcRenderer.invoke("get-friend-detail", puuid),
  getFriendLive: (puuid) => ipcRenderer.invoke("get-friend-live", puuid),

  // Riot account linking (first-run setup)
  getRiotRegions: () => ipcRenderer.invoke("riot-regions"),
  connectRiot: (s) => ipcRenderer.invoke("connect-riot", s),
  skipRiot: () => ipcRenderer.invoke("skip-riot"),

  // Theme / customization
  getTheme: () => ipcRenderer.invoke("get-theme"),
  saveTheme: (patch) => ipcRenderer.invoke("save-theme", patch),
  onTheme: (cb) => ipcRenderer.on("theme", (_e, t) => cb(t)),
  repositionOverlay: () => ipcRenderer.send("overlay-reposition"),
  openReview: () => ipcRenderer.send("open-review"),

  // App info / general settings / data
  getAppInfo: () => ipcRenderer.invoke("get-app-info"),
  setStartup: (on) => ipcRenderer.invoke("set-startup", on),
  clearMatchCache: () => ipcRenderer.invoke("clear-match-cache"),
  openDataFolder: () => ipcRenderer.invoke("open-data-folder"),
  openRepo: () => ipcRenderer.invoke("open-repo"),

  // Frameless window controls
  winMin: () => ipcRenderer.send("win-min"),
  winClose: () => ipcRenderer.send("win-close"),
});
