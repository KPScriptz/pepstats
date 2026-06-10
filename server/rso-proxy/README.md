# PepStats RSO proxy

The server-side half of Riot Sign-On. It exists so that **no credential ever
ships in the desktop app**: the RSO client secret and the production API key
live here; the desktop app only holds a short-lived signed session token.

## Status

Riot production-app application **submitted** — this proxy can't talk to Riot
until the approval email arrives with the client id/secret. Everything else is
ready to go.

## Approval-day checklist

1. Deploy this folder to any Node 18+ host (Fly.io, Render, Railway, a VPS —
   anything with HTTPS). It has **zero dependencies**: `node index.js`.
2. In the Riot developer portal, register the redirect URI:
   `https://<your-host>/auth/callback`
3. Set the environment:

   | Var | Value |
   | --- | --- |
   | `RSO_CLIENT_ID` | from the approved app |
   | `RSO_CLIENT_SECRET` | from the approved app — never leaves the server |
   | `RIOT_API_KEY` | the production key — never leaves the server |
   | `BASE_URL` | `https://<your-host>` (must match the registered redirect) |
   | `SESSION_SECRET` | a long random string (`openssl rand -hex 32`) |

4. Check `https://<your-host>/healthz` returns `"configured": true`.
5. In the PepStats app config (`config.json` in userData), set
   `"rsoBaseUrl": "https://<your-host>"` — the Settings card's
   **Connect via Riot Games** button enables itself from that value.

## Endpoints

- `GET /healthz` — liveness + config check
- `GET /auth/login?port=N` — entry point; 302 to Riot's authorize page
- `GET /auth/callback` — Riot redirects here; exchanges the code, identifies
  the player via `account-v1 /accounts/me`, mints a session, hands off to the
  app's localhost loopback
- `GET /api/me` · `GET /api/matches` · `GET /api/match?id=` — session-scoped
  data, each serving **only the signed-in player's own data** (a match is
  refused unless the player was in it)

Per-IP rate limiting guards the single production key. Extend `/api/*` routes
as desktop features migrate from the developer-key path to the proxy path.
