"use strict";

// Post-game replay detector. Finds the newest .rofl in the user's own Replays
// folder and returns FILE METADATA ONLY (name, size, mtime). We deliberately do
// not parse .rofl internals — the format is proprietary/encrypted, and the
// player's match telemetry comes from the sanctioned Live Client data instead.
const fs = require("fs");
const path = require("path");
const os = require("os");

function replaysDir() {
  // Windows: Documents\League of Legends\Replays. Allow an env override for
  // relocated Documents folders.
  if (process.platform === "win32") {
    const docs = process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "Documents")
      : path.join(os.homedir(), "Documents");
    return path.join(docs, "League of Legends", "Replays");
  }
  // macOS/dev fallback (folder usually absent — returns null gracefully).
  return path.join(os.homedir(), "Documents", "League of Legends", "Replays");
}

function latestReplay() {
  try {
    const dir = replaysDir();
    const entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".rofl"));
    if (!entries.length) return null;

    let newest = null;
    for (const name of entries) {
      try {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (!newest || stat.mtimeMs > newest.mtimeMs) {
          newest = { name, path: full, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, modified: stat.mtime.toISOString() };
        }
      } catch (_) {
        /* skip unreadable entry */
      }
    }
    return newest;
  } catch (_) {
    // Folder missing / no permission — no replay context this game.
    return null;
  }
}

module.exports = { latestReplay, replaysDir };
