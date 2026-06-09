"use strict";

/*
 * liveGameTelemetry — high-frequency, Vanguard-compliant live telemetry loop.
 *
 * Reads ONLY Riot's official Live Client Data server (127.0.0.1:2999), which is
 * sanctioned for read access. Computes the Creep Score Differential (CSD) vs the
 * direct lane opponent while a match is in progress. No automation, no writes.
 *
 * Self-paced: polls every 2000ms; on connection failure (loading screen, alt-
 * tab, no live game) it backs off to 5000ms until a 200 OK returns, and never
 * throws into the main process.
 *
 *   start() / stop() / get() -> latest CSD snapshot
 */

const liveClient = require("../shared/liveClient");

const FAST_MS = 2000;
const SLOW_MS = 5000;

let timer = null;
let interval = FAST_MS;
let latest = { available: false };

function reschedule(next) {
  if (next === interval) return;
  interval = next;
  if (timer) { clearInterval(timer); timer = setInterval(tick, interval); }
}

async function tick() {
  try {
    const data = await liveClient.getAllGameData(1800);
    latest = liveClient.csDifferential(data) || { available: false };
    reschedule(FAST_MS); // healthy → fast cadence
  } catch (_) {
    // Loading / alt-tabbed / no live game — degrade quietly and slow down.
    latest = { available: false };
    reschedule(SLOW_MS);
  }
}

function start() {
  if (timer) return;
  interval = FAST_MS;
  timer = setInterval(tick, interval);
  tick();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  interval = FAST_MS;
  latest = { available: false };
}

function get() { return latest; }

module.exports = { start, stop, get };
