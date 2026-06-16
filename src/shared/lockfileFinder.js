"use strict";

// ---------------------------------------------------------------------------
// Resilient League-of-Legends install discovery + safe lockfile reader.
//
// The LCU lockfile (<install>/lockfile) is the SANCTIONED way to obtain client
// API credentials — it is written by the client itself. We only ever READ it.
// There is no memory reading, process hooking, or injection here; discovery is
// limited to probing well-known paths and a read-only registry query.
//
// Discovery order (first hit wins):
//   1. PEPSTATS_LEAGUE_DIR env override (manual / dev convenience).
//   2. Default install roots across common Windows drives (C:, D:, E:).
//   3. The Windows registry (read-only `reg query`) for the definitive path.
// ---------------------------------------------------------------------------

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { execFile } = require("child_process");

const LOCKFILE_NAME = "lockfile";

// A real install has the client exe at its root; we use it to validate paths.
const CLIENT_EXE = "LeagueClient.exe";

// Relative install layouts seen in the wild, probed under each drive root.
const DEFAULT_SUBPATHS = [
  path.join("Riot Games", "League of Legends"),
  path.join("Program Files", "Riot Games", "League of Legends"),
  path.join("Program Files (x86)", "Riot Games", "League of Legends"),
  path.join("Games", "Riot Games", "League of Legends"),
  path.join("Games", "League of Legends"),
];
const PROBE_DRIVES = ["C:", "D:", "E:"];

// Registry locations that may hold the install path. Value names drift between
// client versions, so each key is also dumped wholesale as a fallback scan.
const REG_SOURCES = [
  { key: "HKLM\\SOFTWARE\\WOW6432Node\\Riot Games, Inc.\\League of Legends", value: "InstallLocation" },
  { key: "HKLM\\SOFTWARE\\WOW6432Node\\Riot Games, Inc.\\League of Legends", value: "Location" },
  { key: "HKCU\\Software\\Riot Games\\League of Legends", value: "Path" },
  { key: "HKCU\\Software\\Riot Games\\RADS", value: "LocalRootFolder" },
];

// ----- small async helpers ---------------------------------------------------
async function pathExists(p) {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}

// macOS install marker (the client app bundle inside Contents/LoL).
const CLIENT_APP_MAC = "LeagueClient.app";

// A directory is a valid install if it holds the client (exe on Windows, the
// .app bundle on macOS) OR a live lockfile.
async function isInstallRoot(dir) {
  if (!dir) return false;
  if (await pathExists(path.join(dir, CLIENT_EXE))) return true;
  if (process.platform === "darwin" && (await pathExists(path.join(dir, CLIENT_APP_MAC)))) return true;
  if (await pathExists(path.join(dir, LOCKFILE_NAME))) return true;
  return false;
}

// Registry values sometimes point one level up (the Riot Games root); accept
// either the path itself or its "League of Legends" subfolder.
async function resolveInstallRoot(candidate) {
  if (!candidate) return null;
  const trimmed = candidate.trim().replace(/^"|"$/g, "");
  if (await isInstallRoot(trimmed)) return trimmed;
  const sub = path.join(trimmed, "League of Legends");
  if (await isInstallRoot(sub)) return sub;
  return null;
}

// Non-blocking child process; never rejects — a failed query just yields "".
function runReg(args) {
  return new Promise((resolve) => {
    execFile("reg", args, { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      resolve(err ? "" : stdout || "");
    });
  });
}

// Pull REG_SZ / REG_EXPAND_SZ payloads out of `reg query` output. When a value
// name is given, only that row is returned; otherwise every string value is.
function parseRegPaths(stdout, valueName) {
  const out = [];
  for (const raw of String(stdout).split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^(.*?)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/);
    if (!m) continue;
    const [, name, data] = m;
    if (valueName && name.toLowerCase() !== valueName.toLowerCase()) continue;
    if (data) out.push(data.trim());
  }
  return out;
}

// ----- discovery -------------------------------------------------------------
function candidateRoots() {
  // macOS: League installs as a single .app; the LCU lockfile + game files live
  // under Contents/LoL. (lcu.js also reads this path directly as a fallback, so
  // the client connects even if findInstallDir is skipped.)
  if (process.platform === "darwin") {
    const home = process.env.HOME || "";
    return [
      "/Applications/League of Legends.app/Contents/LoL",
      home ? path.join(home, "Applications/League of Legends.app/Contents/LoL") : null,
    ].filter(Boolean);
  }
  if (process.platform !== "win32") return [];
  const roots = [];
  for (const drive of PROBE_DRIVES) {
    for (const sub of DEFAULT_SUBPATHS) {
      roots.push(path.join(drive + path.sep, sub));
    }
  }
  return roots;
}

async function fromDefaultPaths() {
  for (const root of candidateRoots()) {
    if (await isInstallRoot(root)) return root;
  }
  return null;
}

async function fromRegistry() {
  if (process.platform !== "win32") return null;
  for (const src of REG_SOURCES) {
    // Targeted lookup first.
    let candidates = parseRegPaths(await runReg(["query", src.key, "/v", src.value]), src.value);
    // Fallback: dump the whole key and scan every string value.
    if (!candidates.length) candidates = parseRegPaths(await runReg(["query", src.key]), null);
    for (const c of candidates) {
      const resolved = await resolveInstallRoot(c);
      if (resolved) return resolved;
    }
  }
  return null;
}

// Resolve the League install directory, or null if it can't be found.
async function findInstallDir() {
  try {
    const override = process.env.PEPSTATS_LEAGUE_DIR;
    if (override && (await isInstallRoot(override))) return override;

    const byPath = await fromDefaultPaths();
    if (byPath) return byPath;

    const byReg = await fromRegistry();
    if (byReg) return byReg;
  } catch (_) {
    /* fall through to null — discovery is best-effort */
  }
  return null;
}

// ----- safe lockfile read ----------------------------------------------------
function parseLockfile(text) {
  // Format: name:pid:port:password:protocol  (password may itself be opaque,
  // but never contains ':', so a 5-field split is safe).
  const parts = String(text).trim().split(":");
  if (parts.length < 5) return null;
  const [name, pid, port, password, protocol] = parts;
  if (!port || !password) return null;
  return { name, pid: Number(pid), port: Number(port), password, protocol };
}

// Read the lockfile READ-ONLY. The 'r' flag never requests a write/exclusive
// handle, and the client keeps the file shared-for-read while running, so this
// cannot trip a Windows sharing violation or block the client.
async function readLockfile(installDir) {
  const file = path.join(installDir, LOCKFILE_NAME);
  const text = await fsp.readFile(file, { encoding: "utf8", flag: "r" });
  const creds = parseLockfile(text);
  if (!creds) throw new Error("lockfile present but unparseable");
  return creds;
}

// Watch the install dir and surface credentials whenever the lockfile appears
// or changes (client launch / relaunch). Returns a stop() function.
//
// We watch the DIRECTORY rather than the file: the client deletes and recreates
// the lockfile on each launch, which invalidates a file-level watch. Reads are
// debounced so we don't fire mid-write, and ENOENT (client not up) is benign.
function watchLockfile(installDir, onCreds, onError) {
  let watcher = null;
  let stopped = false;
  let timer = null;

  const safeRead = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        onCreds(await readLockfile(installDir));
      } catch (e) {
        if (e && e.code === "ENOENT") return; // client simply isn't running
        if (onError) onError(e);
      }
    }, 150);
  };

  try {
    watcher = fs.watch(installDir, { persistent: false }, (_event, filename) => {
      if (!filename || filename === LOCKFILE_NAME) safeRead();
    });
    watcher.on("error", (e) => onError && onError(e));
  } catch (e) {
    if (onError) onError(e);
  }

  safeRead(); // pick up an already-running client immediately

  return function stop() {
    stopped = true;
    clearTimeout(timer);
    if (watcher) {
      try {
        watcher.close();
      } catch (_) {
        /* already closed */
      }
    }
  };
}

module.exports = { findInstallDir, readLockfile, watchLockfile, parseLockfile };
