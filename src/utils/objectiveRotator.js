"use strict";

/*
 * objectiveRotator — time-based objective prep alerts (read-only, sanctioned).
 *
 * Watches the upcoming neutral-objective spawn windows from the existing
 * compliant timer engine (clock + event feed only) and raises a prep alert when
 * one is <=45s away, escalating to a critical (amber) state under 20s.
 *
 * IMPORTANT: this intentionally has NO positional / "you're in the wrong lane"
 * logic. Riot's sanctioned Live Client Data API exposes no champion
 * coordinates, so the lane/quadrant check from the original spec is not
 * buildable without memory/screen reading (a Vanguard violation). This delivers
 * the time-based half only — which is fully compliant.
 *
 *   start() / stop() / get() -> latest alert snapshot
 */

const liveClient = require("../shared/liveClient");
const { computeTimers } = require("../shared/timers");

const FAST_MS = 3000;
const SLOW_MS = 6000;
const ALERT_WINDOW = 45; // seconds before spawn to start warning
const CRITICAL = 20;     // seconds -> amber escalation

let timer = null;
let interval = FAST_MS;
let latest = { alert: false };

// Pure: given the clock + events, return the soonest objective inside the alert
// window (or { alert:false }). Exported for unit testing.
function nextObjectiveAlert(gameTime, events, isClassic) {
  try {
    const timers = computeTimers(gameTime, events, { isClassic });
    const soon = timers
      .filter((o) => o.secondsUntil != null && o.secondsUntil > 0 && o.secondsUntil <= ALERT_WINDOW)
      .sort((a, b) => a.secondsUntil - b.secondsUntil);
    if (!soon.length) return { alert: false };
    const o = soon[0];
    const s = Math.round(o.secondsUntil);
    return {
      alert: true,
      type: "OBJECTIVE_PREP",
      objective: o.label,
      secondsLeft: s,
      critical: s <= CRITICAL,
      message: `${o.label} spawning in ${s}s — set up vision and prep your recall/wave.`,
    };
  } catch (_) {
    return { alert: false };
  }
}

function reschedule(next) {
  if (next === interval) return;
  interval = next;
  if (timer) { clearInterval(timer); timer = setInterval(tick, interval); }
}

async function tick() {
  try {
    const data = await liveClient.getAllGameData(2500);
    const gameTime = (data && data.gameData && data.gameData.gameTime) || 0;
    const events = (data && data.events && data.events.Events) || [];
    const isClassic = liveClient.gameInfo(data).isClassic;
    latest = nextObjectiveAlert(gameTime, events, isClassic);
    reschedule(FAST_MS);
  } catch (_) {
    latest = { alert: false };
    reschedule(SLOW_MS);
  }
}

function start() { if (timer) return; interval = FAST_MS; timer = setInterval(tick, interval); tick(); }
function stop() { if (timer) { clearInterval(timer); timer = null; } interval = FAST_MS; latest = { alert: false }; }
function get() { return latest; }

module.exports = { start, stop, get, nextObjectiveAlert };
