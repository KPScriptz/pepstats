# PepStats — League of Legends & TFT Companion

**Climb smarter. PepStats follows you from champ select to the post-game screen —
the right stats at the right moment, measured against your rank, not a random
opponent.**

A lightweight Windows companion for League of Legends and Teamfight Tactics in a
Blitz-style obsidian + neon-crimson liquid-glass interface. **Works out of the
box**: install, open the League client, click *Connect with League client* — no
sign-ups, no API keys, nothing to type.

➡️ **[Download the latest release](../../releases/latest)**

> Builds are currently **unsigned**, so SmartScreen shows *"Windows protected
> your PC"* → **More info → Run anyway**. (See [SIGNING.md](SIGNING.md).)

## League of Legends

- 🎮 **In-game overlay** — independent, draggable modules (stats, skill hint,
  highlight toasts, gold diff, jungle path) plus per-objective timer chips you
  place anywhere by eye. Click-through during play; `Ctrl+Shift+D` opens Design
  Mode with per-module visibility toggles and persistent layouts.
- 📐 **Rank-baseline HUD** — your CS/min, KP%, KDA, vision and level compared
  live against the average for *your* rank, with a CSM sparkline and pro-pace
  pip. Game-mode aware (no phantom jungle timers in ARAM).
- ⚔️ **Lane dossier** — you vs. your lane opponent (CSM / KDA / level), from the
  same data the Tab scoreboard shows.
- ⏱️ **Objective timers** — camps, scuttle, grubs, Herald, dragon, Baron and
  inhibitor respawns from the live game clock and event feed.
- 🏠 **Dashboard** — rank showcase with LP ring and sparkline, weekly LP, and a
  dense last-10 feed: KDA, Vis/Min, KP%, CS/Min, a performance grade, damage
  share, role/queue/time.
- 📜 **Match history** — filterable, expandable 10-player scoreboards with
  items, runes, damage bars and achievement badges.
- 🧠 **Champ select** — curated situational builds, one-click rune + item-set
  import, a hand-authored Draft Coach, and ally recent-form (allies display as
  "Ally 1–4" per Riot's champ-select anonymity rules).
- 🔍 **Post-game** — tactical dashboard with the team gold graph, badges, and a
  death-by-death deep coach built from your own match timeline.
- 👥 **Friends** — live presence with search, premium profiles (rank medal, win
  rate, top mastery) and a spectator draft view.

## Teamfight Tactics

- 👑 **TFT dashboard** — ranked card with LP ring, top-4 / avg-place / games
  KPIs, your own comp performance trends, and a placement feed with traits,
  board, star levels and your real exit stage.
- 🕸️ **Performance radar** — a five-axis profile of your recent games (Top 4,
  Wins, Econ, Tempo, Consistency).
- 🧩 **Set-correct references** — trait breakpoints and a full item-recipe
  explorer, derived from the current patch's static data files.
- 📝 **Comp planner** — a manual pre-queue checklist built from the live set's
  roster, persisted between sessions.
- 🎲 **Shop odds + over-cap audit** — the per-level roll table, plus a post-game
  flag on trait units that sat between breakpoints buying nothing.

## Learn

A curated fundamentals hub for both games: role macro responsibilities, the
objective spawn cheat-sheet, skill-leveling basics, a glossary, TFT econ and
leveling pacing, queue guides (Hyper Roll / Double Up), and itemization 101.

## AI coaching (optional — your own Anthropic key)

Add your own Claude API key in **Settings → AI** to unlock the rank-up forecast,
champion picks and a streaming post-game coach. Without a key, every AI surface
stays hidden. PepStats ships with **no keys of any kind**.

## Controls

| Shortcut | Action |
| --- | --- |
| **Ctrl + Shift + D** | Overlay: Design Mode (drag/resize/toggle) ⇄ Live Mode (click-through) |
| **Ctrl + Shift + H** | Show the Home client window |
| **Ctrl + Shift + 1 / 2 / 3** | Manually show Pre-Game / In-Game / Post-Game (testing) |
| **Ctrl + Shift + Q** | Quit |

PepStats switches automatically: champ select → Pre-Game, live match → In-Game
overlay, match end → Post-Game review, otherwise → the Home client.

## Safe by design — Vanguard compliant

PepStats reads **only Riot-sanctioned data**: the Live Client Data API
(`127.0.0.1:2999`), the local League client (LCU — reads plus the two tolerated
writes, rune pages and item sets), official Riot APIs, and static data CDNs
(Data Dragon / CommunityDragon).

- ❌ No screen capture, computer vision, or minimap reading
- ❌ No memory reading, injection, or input automation
- ❌ No enemy cooldown timers — not even manual ones (Riot policy)
- ❌ No action-dictating alerts, no TFT augment stats, no scraped stat sites
- ❌ **No API keys requested from users, ever** — full online features arrive
  via official **Riot Sign-On** (production application submitted; the
  server-side proxy lives in [`server/rso-proxy/`](server/rso-proxy/))

The overlay is a separate transparent window (like Discord's), never injected.
Every feature is audited against Riot's written third-party policy — the full
feature-by-feature record lives in [COMPLIANCE.md](COMPLIANCE.md).

## Project structure

```
pepstats/
├── .github/workflows/build.yml  # Windows installer CI → rolling `latest` release
├── COMPLIANCE.md                # the standing policy audit record
├── server/rso-proxy/            # Riot Sign-On proxy (server-side; NOT in the exe)
├── src/
│   ├── main.js                  # window state machine, poll loop, IPC
│   ├── preload.js               # contextBridge API (role-aware)
│   ├── shared/                  # liveClient, riotApi, lcu, lcuHistory, rso, timers…
│   ├── utils/                   # post-game, TFT, friends, telemetry engines
│   └── windows/                 # home / pregame / ingame / postgame renderers
└── config.example.json          # optional developer config (gitignored config.json)
```

## Local development (Node.js)

```bash
npm install
npm start        # run PepStats locally
npm run check    # syntax-check all sources
npm run dist     # build the Windows installer (run on Windows)
```

## License

MIT
