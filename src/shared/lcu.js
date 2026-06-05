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

function lockfilePaths() {
  const candidates = [];
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

module.exports = { request, getGameflowPhase, getChampSelectSession, readLockfile };
