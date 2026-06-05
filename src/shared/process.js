"use strict";

// Lightweight process watcher. Detects whether the League client / game are
// running so we can start/stop the LCU socket and avoid hammering APIs when
// nothing is up. Uses the OS process list only — NO window scraping, memory
// reading, or hooking. Spawns a short-lived shell check on a slow cadence.
const { exec } = require("child_process");

const CLIENT_PROC = process.platform === "win32" ? "LeagueClient.exe" : "LeagueClient";
const GAME_PROC = process.platform === "win32" ? "League of Legends.exe" : "League of Legends";

function checkProcess(name) {
  return new Promise((resolve) => {
    let cmd;
    if (process.platform === "win32") {
      // /NH = no header, /FI filter. Output contains the image name when present.
      cmd = `tasklist /FI "IMAGENAME eq ${name}" /NH`;
    } else {
      // Dev convenience on macOS/Linux; the real target is Windows.
      cmd = `pgrep -x ${JSON.stringify(name)}`;
    }
    exec(cmd, { timeout: 1500, windowsHide: true }, (err, stdout) => {
      if (err) {
        // pgrep exits 1 when nothing matches.
        resolve(false);
        return;
      }
      const out = (stdout || "").toLowerCase();
      if (process.platform === "win32") {
        // tasklist exits 0 even on no match and prints an INFO line to stdout,
        // so test for the actual image name rather than non-empty output.
        resolve(out.includes(name.toLowerCase()));
      } else {
        // pgrep prints PIDs on success (exit 0), nothing on failure (exit 1).
        resolve(out.trim().length > 0);
      }
    });
  });
}

async function isClientRunning() {
  try {
    return await checkProcess(CLIENT_PROC);
  } catch (_) {
    return false;
  }
}

async function isGameRunning() {
  try {
    return await checkProcess(GAME_PROC);
  } catch (_) {
    return false;
  }
}

module.exports = { isClientRunning, isGameRunning };
