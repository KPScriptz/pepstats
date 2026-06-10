"use strict";

/*
 * PepStats RSO proxy — the server-side half of Riot Sign-On.
 *
 * WHY THIS EXISTS: Riot's developer terms forbid shipping credentials in the
 * client. The RSO client secret and the production API key live HERE, on a
 * host the developer controls; the desktop app only ever holds a short-lived
 * signed session token. End users never see a key of any kind.
 *
 * FLOW (OAuth2 authorization code):
 *   1. Desktop app starts a one-shot localhost listener on a random port and
 *      opens the system browser at  {BASE_URL}/auth/login?port=NNNN
 *   2. /auth/login 302s to Riot's authorize endpoint (auth.riotgames.com).
 *   3. The player signs in ON RIOT'S SITE — never inside PepStats.
 *   4. Riot redirects to {BASE_URL}/auth/callback?code=...&state=...
 *   5. The proxy exchanges the code (client_secret_basic), calls
 *      /riot/account/v1/accounts/me with the access token to learn who the
 *      player is (gameName/tagLine/puuid), mints an HMAC-signed session token
 *      binding that puuid, and 302s to http://127.0.0.1:NNNN/done#token=...
 *   6. The desktop app catches the redirect, stores the session, and from then
 *      on calls {BASE_URL}/api/* with  Authorization: Bearer <session>.
 *      Every /api/* route serves ONLY the data of the puuid inside the session,
 *      fetched with the production key that never leaves this server.
 *
 * RUNTIME CONFIG (env — set after Riot approves the production app):
 *   RSO_CLIENT_ID      OAuth client id from the approved app
 *   RSO_CLIENT_SECRET  OAuth client secret (server-side only, forever)
 *   RIOT_API_KEY       production API key (server-side only, forever)
 *   BASE_URL           public https URL of this proxy (must match the
 *                      redirect_uri registered with Riot: BASE_URL/auth/callback)
 *   SESSION_SECRET     long random string for HMAC session signing
 *   PORT               listen port (default 8788)
 *
 * Zero dependencies — plain Node. Deploy anywhere that runs Node 18+.
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");

const ENV = {
  clientId: process.env.RSO_CLIENT_ID || "",
  clientSecret: process.env.RSO_CLIENT_SECRET || "",
  riotKey: process.env.RIOT_API_KEY || "",
  baseUrl: (process.env.BASE_URL || "").replace(/\/$/, ""),
  sessionSecret: process.env.SESSION_SECRET || "",
  port: Number(process.env.PORT || 8788),
};

const RSO_AUTH = "https://auth.riotgames.com/authorize";
const RSO_TOKEN = "https://auth.riotgames.com/token";
const ACCOUNT_ME = "https://americas.api.riotgames.com/riot/account/v1/accounts/me";

// ---- tiny helpers -----------------------------------------------------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}
function fetchJson(urlStr, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      { host: u.host, path: u.pathname + u.search, method: opts.method || "GET", headers: opts.headers || {}, timeout: 8000 },
      (r) => {
        let data = "";
        r.setEncoding("utf8");
        r.on("data", (c) => (data += c));
        r.on("end", () => {
          if (r.statusCode >= 200 && r.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("bad json")); }
          } else reject(Object.assign(new Error("HTTP " + r.statusCode), { status: r.statusCode }));
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---- signed sessions (stateless: payload + HMAC) -----------------------------
function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", ENV.sessionSecret).update(data).digest("base64url");
  return data + "." + mac;
}
function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [data, mac] = token.split(".");
  const expect = crypto.createHmac("sha256", ENV.sessionSecret).update(data).digest("base64url");
  const a = Buffer.from(mac || ""), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString());
    if (!p.puuid || !p.exp || Date.now() > p.exp) return null;
    return p;
  } catch (_) { return null; }
}

// Loopback `state` params are signed too, so the callback can't be pointed at
// an arbitrary port by a third party.
function signState(port) {
  return signSession({ puuid: "state", port, exp: Date.now() + 10 * 60 * 1000 });
}
function verifyState(state) {
  const p = verifySession(state);
  return p && p.puuid === "state" && Number.isInteger(p.port) && p.port > 0 && p.port < 65536 ? p.port : null;
}

// ---- naive per-IP rate limit (the proxy guards ONE production key) ----------
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const h = (hits.get(ip) || []).filter((t) => now - t < 60000);
  h.push(now);
  hits.set(ip, h);
  return h.length > 60;
}

// ---- routes ------------------------------------------------------------------
async function handle(req, res) {
  const ip = req.socket.remoteAddress || "?";
  const u = new URL(req.url, "http://x");

  if (u.pathname === "/healthz") {
    return json(res, 200, { ok: true, configured: !!(ENV.clientId && ENV.clientSecret && ENV.riotKey && ENV.baseUrl && ENV.sessionSecret) });
  }

  if (limited(ip)) return json(res, 429, { error: "slow down" });

  // 1) Kick off RSO. The desktop app passes its loopback port.
  if (u.pathname === "/auth/login") {
    const port = Number(u.searchParams.get("port"));
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return json(res, 400, { error: "bad port" });
    if (!ENV.clientId || !ENV.baseUrl) return json(res, 503, { error: "proxy not configured (pending Riot approval)" });
    const q = new URLSearchParams({
      client_id: ENV.clientId,
      redirect_uri: ENV.baseUrl + "/auth/callback",
      response_type: "code",
      scope: "openid offline_access",
      state: signState(port),
    });
    return redirect(res, RSO_AUTH + "?" + q);
  }

  // 2) Riot sends the player back here; exchange + identify + hand off to the app.
  if (u.pathname === "/auth/callback") {
    const code = u.searchParams.get("code");
    const port = verifyState(u.searchParams.get("state") || "");
    if (!code || !port) return json(res, 400, { error: "bad callback" });
    try {
      const basic = Buffer.from(ENV.clientId + ":" + ENV.clientSecret).toString("base64");
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: ENV.baseUrl + "/auth/callback",
      }).toString();
      const tok = await fetchJson(RSO_TOKEN, {
        method: "POST",
        headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
      }, body);
      const me = await fetchJson(ACCOUNT_ME, { headers: { Authorization: "Bearer " + tok.access_token } });
      const session = signSession({
        puuid: me.puuid,
        riotId: (me.gameName || "") + (me.tagLine ? "#" + me.tagLine : ""),
        exp: Date.now() + 30 * 24 * 3600 * 1000, // 30 days; reconnect re-mints
      });
      return redirect(res, `http://127.0.0.1:${port}/done#token=${encodeURIComponent(session)}`);
    } catch (e) {
      return redirect(res, `http://127.0.0.1:${port}/done#error=${encodeURIComponent(e.message || "auth failed")}`);
    }
  }

  // 3) Data endpoints: session-scoped, production key never leaves the server.
  //    Each route serves ONLY the authenticated player's own data.
  if (u.pathname.startsWith("/api/")) {
    const sess = verifySession((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!sess) return json(res, 401, { error: "sign in again" });
    const keyHdr = { headers: { "X-Riot-Token": ENV.riotKey } };
    try {
      if (u.pathname === "/api/me") return json(res, 200, { puuid: sess.puuid, riotId: sess.riotId });
      if (u.pathname === "/api/matches") {
        const count = Math.min(20, Math.max(1, Number(u.searchParams.get("count")) || 10));
        const cluster = u.searchParams.get("cluster") === "asia" ? "asia" : u.searchParams.get("cluster") === "europe" ? "europe" : "americas";
        const ids = await fetchJson(`https://${cluster}.api.riotgames.com/lol/match/v5/matches/by-puuid/${sess.puuid}/ids?start=0&count=${count}`, keyHdr);
        return json(res, 200, { ids });
      }
      if (u.pathname === "/api/match") {
        const id = String(u.searchParams.get("id") || "");
        if (!/^[A-Z0-9_]+$/i.test(id)) return json(res, 400, { error: "bad id" });
        const cluster = u.searchParams.get("cluster") === "asia" ? "asia" : u.searchParams.get("cluster") === "europe" ? "europe" : "americas";
        const m = await fetchJson(`https://${cluster}.api.riotgames.com/lol/match/v5/matches/${id}`, keyHdr);
        // Privacy line: only return matches the signed-in player took part in.
        const mine = m && m.metadata && Array.isArray(m.metadata.participants) && m.metadata.participants.includes(sess.puuid);
        if (!mine) return json(res, 403, { error: "not your match" });
        return json(res, 200, m);
      }
      return json(res, 404, { error: "unknown endpoint" });
    } catch (e) {
      return json(res, e.status === 429 ? 429 : 502, { error: e.message });
    }
  }

  json(res, 404, { error: "not found" });
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => json(res, 500, { error: e.message }));
}).listen(ENV.port, () => {
  console.log(`[rso-proxy] listening on :${ENV.port} configured=${!!(ENV.clientId && ENV.riotKey)}`);
});
