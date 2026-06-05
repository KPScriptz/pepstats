"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const role =
  (process.argv.find((a) => a.startsWith("--pepstats-role=")) || "").split("=")[1] || "ingame";

contextBridge.exposeInMainWorld("pepstats", {
  role,
  // In-game overlay
  onOverlay: (cb) => ipcRenderer.on("overlay", (_e, data) => cb(data)),
  onModeChange: (cb) => ipcRenderer.on("mode-change", (_e, mode) => cb(mode)),
  // Pre-game
  getPregame: () => ipcRenderer.invoke("get-pregame"),
  // Post-game
  getLastGame: () => ipcRenderer.invoke("get-last-game"),
  requestCoach: () => ipcRenderer.invoke("request-coach"),
});
