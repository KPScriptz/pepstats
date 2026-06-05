"use strict";

// Compliant "jungle helper": next-spawn timers for epic objectives, computed
// purely from the sanctioned Live Client API — game clock + kill events. No
// screen reading, no enemy tracking. Constants are patch-tunable; edit freely.
const OBJECTIVES = {
  grubs: { label: "Voidgrubs", first: 6 * 60, respawn: null, event: "HordeKill" },
  dragon: { label: "Dragon", first: 5 * 60, respawn: 5 * 60, event: "DragonKill" },
  baron: { label: "Baron", first: 25 * 60, respawn: 6 * 60, event: "BaronKill" },
};

const fmtClock = (s) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
};

function lastKillTime(events, eventName) {
  let t = null;
  for (const e of events || []) {
    if (e.EventName === eventName && typeof e.EventTime === "number") {
      if (t === null || e.EventTime > t) t = e.EventTime;
    }
  }
  return t;
}

function computeTimers(gameTime, events) {
  const out = {};
  for (const key of Object.keys(OBJECTIVES)) {
    const cfg = OBJECTIVES[key];
    const lastKill = lastKillTime(events, cfg.event);

    let secondsUntil = null;
    let status = "up";

    if (lastKill !== null) {
      if (cfg.respawn === null) {
        status = "gone"; // one-time objective already taken (e.g. grubs)
      } else {
        const next = lastKill + cfg.respawn;
        secondsUntil = Math.max(0, next - gameTime);
        status = secondsUntil > 0 ? "respawning" : "up";
      }
    } else if (gameTime < cfg.first) {
      secondsUntil = cfg.first - gameTime;
      status = "spawning";
    }

    out[key] = {
      label: cfg.label,
      status,
      secondsUntil,
      display: secondsUntil !== null ? fmtClock(secondsUntil) : status === "gone" ? "—" : "UP",
    };
  }
  return out;
}

module.exports = { computeTimers, fmtClock };
