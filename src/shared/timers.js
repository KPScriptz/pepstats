"use strict";

// Compliant objective state machine. Everything here is derived from two
// sanctioned Live Client signals only: the game clock and the event stream
// (HordeKill / HeraldKill / DragonKill / BaronKill). There is NO map-state in
// the public API — we cannot see whether a monster is physically on the map or
// "in combat", so those cases are modeled deterministically from the clock.
//
// All constants are patch-tunable in one place. They drift most patches; treat
// them as approximate and verify against the live patch when accuracy matters.
const C = {
  GRUB_FIRST: 5 * 60,        // first Voidgrub wave spawns
  GRUB_PER_WAVE: 3,          // grubs per wave (approx; patch-dependent)
  GRUB_MAX_WAVES: 2,         // up to two waves modeled
  GRUB_WAVE2_QUEUE_BEFORE: 13 * 60 + 45, // wave-1 clear before 13:45 queues wave 2
  GRUB_WAVE2_DELAY: 240,     // 4:00 after wave-1 clear

  HERALD_SPAWN: 14 * 60,     // Rift Herald spawns (and grubs vacate the pit)
  HERALD_DESPAWN: 19 * 60 + 45, // Herald hard-despawns for Baron

  BARON_SPAWN: 20 * 60,      // Baron Nashor spawns
  BARON_RESPAWN: 6 * 60,     // respawn after a kill

  DRAGON_FIRST: 5 * 60,
  DRAGON_RESPAWN: 5 * 60,

  INHIB_RESPAWN: 5 * 60,     // an inhibitor regenerates 5:00 after destruction
};

// Inhibitor structure id -> lane. League names them "Barracks_T{1|2}{L|C|R}1":
// T1 = blue side (ORDER), T2 = red side (CHAOS); L/C/R = top/mid/bottom.
const INHIB_LANE = { L: "Top", C: "Mid", R: "Bot" };

const fmtClock = (s) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
};

function killTimes(events, name) {
  const out = [];
  for (const e of events || []) {
    if (e.EventName === name && typeof e.EventTime === "number") out.push(e.EventTime);
  }
  out.sort((a, b) => a - b);
  return out;
}

function node(key, label, status, secondsUntil) {
  return {
    key,
    label,
    status, // "spawning" | "up" | "respawning" | "gone"
    secondsUntil,
    display:
      secondsUntil != null ? fmtClock(secondsUntil) : status === "gone" ? "—" : "UP",
  };
}

function grubsState(t, events) {
  // Grubs vacate the pit once Herald spawns.
  if (t >= C.HERALD_SPAWN) return node("grubs", "Voidgrubs", "gone", null);

  const kills = killTimes(events, "HordeKill");
  const clearedWaves = Math.floor(kills.length / C.GRUB_PER_WAVE);
  if (clearedWaves >= C.GRUB_MAX_WAVES) return node("grubs", "Voidgrubs", "gone", null);

  const lastKill = kills.length ? kills[kills.length - 1] : null;
  if (clearedWaves >= 1 && lastKill != null && lastKill < C.GRUB_WAVE2_QUEUE_BEFORE) {
    const next = lastKill + C.GRUB_WAVE2_DELAY;
    if (t < next) return node("grubs", "Voidgrubs", "respawning", Math.max(0, next - t));
    return node("grubs", "Voidgrubs", "up", null);
  }

  if (t < C.GRUB_FIRST) return node("grubs", "Voidgrubs", "spawning", C.GRUB_FIRST - t);
  return node("grubs", "Voidgrubs", "up", null);
}

function heraldState(t, events) {
  if (killTimes(events, "HeraldKill").length > 0) return node("herald", "Rift Herald", "gone", null);
  if (t >= C.HERALD_DESPAWN) return node("herald", "Rift Herald", "gone", null); // despawns for Baron
  if (t < C.HERALD_SPAWN) return node("herald", "Rift Herald", "spawning", C.HERALD_SPAWN - t);
  return node("herald", "Rift Herald", "up", null);
}

function dragonState(t, events) {
  const kills = killTimes(events, "DragonKill");
  const last = kills.length ? kills[kills.length - 1] : null;
  if (last != null) {
    const next = last + C.DRAGON_RESPAWN;
    if (t < next) return node("dragon", "Dragon", "respawning", Math.max(0, next - t));
    return node("dragon", "Dragon", "up", null);
  }
  if (t < C.DRAGON_FIRST) return node("dragon", "Dragon", "spawning", C.DRAGON_FIRST - t);
  return node("dragon", "Dragon", "up", null);
}

function baronState(t, events) {
  const kills = killTimes(events, "BaronKill");
  const last = kills.length ? kills[kills.length - 1] : null;
  if (last != null) {
    const next = last + C.BARON_RESPAWN;
    if (t < next) return node("baron", "Baron", "respawning", Math.max(0, next - t));
    return node("baron", "Baron", "up", null);
  }
  if (t < C.BARON_SPAWN) return node("baron", "Baron", "spawning", C.BARON_SPAWN - t);
  return node("baron", "Baron", "up", null);
}

// Inhibitor respawn timers, derived ONLY from the sanctioned `InhibKilled`
// event (+ the fixed 5:00 respawn). We key by structure id and keep the LATEST
// kill time per inhibitor (it can be destroyed again after regenerating), then
// emit a "respawning" node for every inhibitor still down. Nothing here reads
// map/vision state — only the event the live API already publishes.
//
// NOTE: structure (turret) timers aren't included — turrets don't respawn — and
// JUNGLE CAMP timers are deliberately absent: the sanctioned API exposes no
// "camp cleared" signal, so the only way to time camps would be screen-reading
// or memory access, both of which are forbidden.
function inhibitorStates(t, events) {
  const lastKill = {};
  for (const e of events || []) {
    if (e.EventName === "InhibKilled" && typeof e.EventTime === "number") {
      lastKill[e.InhibKilled || ""] = e.EventTime; // events are chronological
    }
  }
  const out = [];
  for (const id of Object.keys(lastKill)) {
    const next = lastKill[id] + C.INHIB_RESPAWN;
    if (t >= next) continue; // already regenerated
    const m = /Barracks_T(\d)([LCR])/i.exec(id);
    const side = m ? (m[1] === "1" ? "B" : "R") : "?";
    const lane = m ? INHIB_LANE[m[2].toUpperCase()] || "?" : "?";
    out.push(node("inhib-" + id, `Inhib ${lane} (${side})`, "respawning", Math.max(0, next - t)));
  }
  out.sort((a, b) => (a.secondsUntil || 0) - (b.secondsUntil || 0));
  return out;
}

// Ordered array for the overlay's vertical timeline.
//
// `opts.isClassic` gates the whole timeline: grubs/herald/dragon/baron exist
// ONLY on Summoner's Rift. In ARAM (and Arena/URF/etc.) there is no jungle, so
// we return an empty array rather than phantom objectives. When `opts` is
// omitted we default to the SR set (keeps the standalone overlay preview and
// older callers working).
function computeTimers(gameTime, events, opts) {
  if (opts && !opts.isClassic) return [];
  const t = gameTime || 0;
  return [
    grubsState(t, events),
    heraldState(t, events),
    dragonState(t, events),
    baronState(t, events),
    ...inhibitorStates(t, events),
  ];
}

module.exports = { computeTimers, fmtClock, OBJECTIVE_CONSTANTS: C };
