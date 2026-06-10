"use strict";

/*
 * rso — desktop half of Riot Sign-On.
 *
 * The app never sees a credential: it opens the SYSTEM BROWSER at the proxy's
 * /auth/login, the player signs in on Riot's own site, and the proxy redirects
 * back to a one-shot localhost listener with a signed session token. That
 * token (identity only — puuid + riotId) is all the desktop ever stores.
 *
 *   connect(baseUrl, openExternal) -> { ok, token, riotId } | { ok:false, error }
 */

const http = require("http");

const TIMEOUT_MS = 3 * 60 * 1000; // give the player three minutes to sign in

// The page the player's browser lands on after the handoff. The token rides in
// the URL FRAGMENT (never sent to any server); this tiny page forwards it to
// the loopback listener via a same-origin fetch, then tells the player to
// return to the app.
const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>PepStats</title>
<body style="background:#0b0c10;color:#e8edf3;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2 id="t">Finishing sign-in…</h2><p style="color:#73798c">You can close this tab and return to PepStats.</p></div>
<script>
  var h = new URLSearchParams(location.hash.slice(1));
  fetch("/capture?" + h.toString(), { method: "POST" }).then(function () {
    document.getElementById("t").textContent = h.get("error") ? "Sign-in failed" : "Connected!";
  });
</script></body>`;

function connect(baseUrl, openExternal) {
  return new Promise((resolve) => {
    if (!baseUrl) return resolve({ ok: false, error: "Riot Sign-On isn't configured yet (pending approval)." });
    let settled = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch (_) {}
      resolve(out);
    };

    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname === "/done") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DONE_PAGE);
        return;
      }
      if (u.pathname === "/capture") {
        res.writeHead(204);
        res.end();
        const err = u.searchParams.get("error");
        const token = u.searchParams.get("token");
        if (err) finish({ ok: false, error: err });
        else if (token) finish({ ok: true, token });
        else finish({ ok: false, error: "No token returned." });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    // Loopback only — never exposed off-machine.
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      openExternal(`${baseUrl.replace(/\/$/, "")}/auth/login?port=${port}`);
    });
    server.on("error", (e) => finish({ ok: false, error: e.message }));

    const timer = setTimeout(() => finish({ ok: false, error: "Sign-in timed out — try again." }), TIMEOUT_MS);
  });
}

module.exports = { connect };
