"use strict";

// Persistent LCU event-socket connector. Subscribes to the champ-select session
// over the client's WAMP-style WebSocket so the Pre-Game window gets real-time
// team comps / pick steps instead of 3s polling. Reads-only; gray-area LCU.
//
// Resilience: auto-reconnects with backoff when the client isn't up yet or the
// user reboots League. Falls back silently to null — callers keep polling.
const EventEmitter = require("events");
const WebSocket = require("ws");
const { readLockfile } = require("./lcu");

const CHAMP_SELECT_EVENT = "OnJsonApiEvent_lol-champ-select_v1_session";
const RECONNECT_MIN_MS = 1500;
const RECONNECT_MAX_MS = 15000;

class LcuSocket extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.stopped = false;
    this.backoff = RECONNECT_MIN_MS;
    this.reconnectTimer = null;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch (_) {
        /* ignore */
      }
      this.ws = null;
    }
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
  }

  _connect() {
    if (this.stopped) return;

    const lock = readLockfile();
    if (!lock) {
      // Client not running yet — try again later.
      this._scheduleReconnect();
      return;
    }

    const auth = "Basic " + Buffer.from("riot:" + lock.password).toString("base64");
    let ws;
    try {
      ws = new WebSocket("wss://127.0.0.1:" + lock.port, {
        headers: { Authorization: auth },
        rejectUnauthorized: false,
        handshakeTimeout: 4000,
      });
    } catch (e) {
      console.warn("[lcuSocket] connect threw:", e.message);
      this._scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.on("open", () => {
      this.backoff = RECONNECT_MIN_MS;
      // WAMP subscribe: [5, eventName]. Events then arrive as [8, eventName, payload].
      try {
        ws.send(JSON.stringify([5, CHAMP_SELECT_EVENT]));
      } catch (_) {
        /* ignore */
      }
      this.emit("open");
      console.log("[lcuSocket] connected to LCU event socket");
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }
      // [opcode, eventName, { data, eventType, uri }]
      if (Array.isArray(msg) && msg[1] === CHAMP_SELECT_EVENT && msg[2]) {
        const { data, eventType } = msg[2];
        if (eventType === "Delete" || data == null) {
          this.emit("champ-select-end");
        } else {
          this.emit("champ-select", data);
        }
      }
    });

    ws.on("close", () => {
      this.emit("close");
      this._scheduleReconnect();
    });

    ws.on("error", (err) => {
      // Expected churn while the client starts/stops — log quietly, don't crash.
      console.warn("[lcuSocket] socket error:", err.message);
      try {
        ws.terminate();
      } catch (_) {
        /* ignore */
      }
    });
  }
}

module.exports = { LcuSocket };
