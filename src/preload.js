"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const role =
  (process.argv.find((a) => a.startsWith("--pepstats-role=")) || "").split("=")[1] || "ingame";

contextBridge.exposeInMainWorld("pepstats", {
  role,

  // In-game overlay
  onOverlay: (cb) => ipcRenderer.on("overlay", (_e, data) => cb(data)),
  onModeChange: (cb) => ipcRenderer.on("mode-change", (_e, mode) => cb(mode)),

  // Pre-game (poll + live push from the LCU socket)
  getPregame: () => ipcRenderer.invoke("get-pregame"),
  onChampSelect: (cb) => ipcRenderer.on("champ-select", (_e, data) => cb(data)),

  // Post-game
  getLastGame: () => ipcRenderer.invoke("get-last-game"),
  onLastGame: (cb) => ipcRenderer.on("last-game", (_e, data) => cb(data)),

  // Streaming AI coach
  startCoach: () => ipcRenderer.send("coach-start"),
  onCoachChunk: (cb) => ipcRenderer.on("coach-chunk", (_e, text) => cb(text)),
  onCoachDone: (cb) => ipcRenderer.on("coach-done", (_e, data) => cb(data)),
  onCoachError: (cb) => ipcRenderer.on("coach-error", (_e, msg) => cb(msg)),
});
