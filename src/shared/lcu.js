"use strict";

// LCU (League Client Update) API connector. Used by the Pre-Game window for
// champ-select phase detection and rune/build import.
//
// NOTE (gray area): Riot tolerates LCU reads and rune imports (Blitz, Mobalytics
// do this), but it is NOT an officially supported public API. Keep usage to
// reads + standard rune-page writes; avoid automating gameplay actions.
//
// Auth comes from the client's lockfile: "name:pid:port:password:protocol".
// On macOS the client/lockfile usually isn't present, so this resolves to null
// and the Pre-Game features simply stay idle.
const fs = require("fs");
const path = require("path");
const https = require("https");
const { findInstallDir } = require("./lockfileFinder");

// Resilient install dir (default-path probe + registry), resolved at startup.
// Until set, we fall back to the hardcoded default candidates below.
let _installDir = null;
let _initInFlight = null;

// Resolve and cache the League install directory. Idempotent and concurrency-
// safe; keeps re-probing only while still unresolved (e.g. client not up yet).
function init() {
  if (_installDir) return Promise.resolve(_installDir);
  if (_initInFlight) return _initInFlight;
  _initInFlight = findInstallDir()
    .then((dir) => {
      _installDir = dir;
      if (dir) console.log("[lcu] League install dir:", dir);
      return dir;
    })
    .catch(() => null)
    .finally(() => {
      _initInFlight = null;
    });
  return _initInFlight;
}

function lockfilePaths() {
  const candidates = [];
  if (_installDir) candidates.push(path.join(_installDir, "lockfile"));
  if (process.platform === "win32") {
    candidates.push("C:/Riot Games/League of Legends/lockfile");
    if (process.env.LOCALAPPDATA) {
      candidates.push(
        path.join(process.env.LOCALAPPDATA, "Riot Games/League of Legends/lockfile")
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/League of Legends.app/Contents/LoL/lockfile"
    );
  }
  return candidates;
}

function readLockfile() {
  for (const p of lockfilePaths()) {
    try {
      const raw = fs.readFileSync(p, "utf8").trim();
      const [name, pid, port, password, protocol] = raw.split(":");
      return { name, pid, port: Number(port), password, protocol };
    } catch (_) {
      /* try next */
    }
  }
  return null;
}

function request(pathname, { method = "GET", body } = {}) {
  const lock = readLockfile();
  if (!lock) return Promise.reject(new Error("LCU not running"));

  const payload = body ? JSON.stringify(body) : null;
  const auth = "Basic " + Buffer.from("riot:" + lock.password).toString("base64");

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port: lock.port,
        path: pathname,
        method,
        rejectUnauthorized: false,
        timeout: 2000,
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(data ? JSON.parse(data) : null);
          } catch (_) {
            resolve(data);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// "None" | "Lobby" | "ChampSelect" | "InProgress" | "EndOfGame" | ...
const getGameflowPhase = () =>
  request("/lol-gameflow/v1/gameflow-phase").catch(() => "None");

const getChampSelectSession = () =>
  request("/lol-champ-select/v1/session").catch(() => null);

// Import a rune page into the client (tolerated LCU write). Frees a slot by
// deleting a deletable page (preferring the current one), then creates + selects
// the new page. `page` = { name, primaryStyleId, subStyleId, selectedPerkIds }.
async function importRunePage(page) {
  let pages = [];
  try { pages = await request("/lol-perks/v1/pages"); } catch (_) { pages = []; }
  const deletable = (Array.isArray(pages) ? pages : []).filter((p) => p && p.isDeletable);
  const victim = deletable.find((p) => p.current) || deletable[0];
  if (victim) { try { await request("/lol-perks/v1/pages/" + victim.id, { method: "DELETE" }); } catch (_) {} }
  return request("/lol-perks/v1/pages", { method: "POST", body: { ...page, current: true } });
}

module.exports = { request, getGameflowPhase, getChampSelectSession, importRunePage, readLockfile, init };
