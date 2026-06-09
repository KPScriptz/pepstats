# PepStats — Architecture

A League of Legends desktop companion (the "Blitz-style" feature set) built on
Electron + Node, **Vanguard-safe by construction**: it only reads sanctioned
APIs, never touches the game process, never automates gameplay. See
[`COMPLIANCE.md`](./COMPLIANCE.md).

## Process model

```
main process (src/main.js)
├─ state machine: IDLE → PREGAME → INGAME → POSTGAME (drives which window owns the screen)
├─ engines: process watcher · LCU socket · 1 Hz Live-Client poll · streaming AI coach
├─ IPC (ipcMain) + theme/config (loadConfig/saveConfig over userData/config.json)
└─ window factories
preload (src/preload.js) — contextBridge IPC surface (sandbox + contextIsolation)
renderers (src/windows/<role>/)
├─ home      — 1920×1080 hub: dashboard, Progress (match history/analytics), Friends, Settings
├─ pregame   — champ-select dashboard: lobby, Draft Coach, curated builds, rune/item import
├─ ingame    — TRANSPARENT, click-through overlay (separate window; never injected)
└─ postgame  — 3-column tactical review + AI coach
shared logic (src/shared/, src/utils/) — pure Node modules, unit-testable
```

Data sources (the only ones, all sanctioned): **Live Client API** `127.0.0.1:2999`
(read-only), **LCU API** via the client lockfile (reads + rune/item-set writes
only), **official Riot Web API** `*.api.riotgames.com` (user's own key),
**Data Dragon / CommunityDragon** CDNs, and optionally the **Anthropic API**
(user-supplied key) for the AI coach.

---

## Pillar 1 — LCU / client interaction

| Spec item | Implemented in |
| --- | --- |
| **LCU connector** (HTTPS + WebSocket) | `shared/lcu.js` (lockfile-authed HTTPS `request()`), `shared/lcuSocket.js` (WAMP event socket → champ-select), `shared/lockfileFinder.js` (resilient install discovery, read-only) |
| **Champ-select scouting** | `lcuSocket` champ-select events → `pregame`; `main.getLobbyAllies` + `riotApi.recentByPuuid` (allies' last-5 WR/KDA, main champ → "one-trick" tag from real match-v5 data); `shared/draftCoach.js` (curated counters/synergies) |
| **Rune + item injector** | `lcu.importRunePage` (`/lol-perks`), `lcu.importItemSet` (`/lol-item-sets`), curated pages in `shared/builds.js`. Triggered by the user's Import button. |
| **Post-match analysis** | `utils/postgameEngine.js` (gold-spend efficiency, skill-order deviation, team gold diff), `liveClient.matchAwards` (MVP/Ace/Vision-Demon/Troll-Bait grade signals), `utils/buildDataEngine.js`, `shared/deepCoach.js` (death-by-death), `shared/advisor.js` (free offline review) |

**Compliance notes (Pillar 1):**
- *Scouting:* allies are real (match-v5 by PUUID). **Enemies are hidden in champ
  select** (no PUUIDs) — no pre-game enemy scouting is possible.
- *"Highest win-rate" runes/builds:* **curated**, not scraped — Riot has no
  matchup/tier API and scraping op.gg/u.gg is off-limits.
- *"Auto-inject the moment a champion locks":* kept **user-triggered** (one
  click). Auto-on-lock is feasible (rune/item writes are tolerated) but should
  stay behind an explicit opt-in to remain clearly on the safe side of "no
  gameplay automation."

---

## Pillar 2 — data engine & profiles

| Spec item | Implemented in |
| --- | --- |
| **Profile / history / mastery / trends (20+ games)** | `shared/riotApi.js` (account-v1, summoner-v4, league-v4, match-v5 + timeline, champion-mastery-v4, spectator-v5, tft-match-v1), `shared/rankProgress.js`, `shared/rankBaseline.js`; surfaced in `home` (Dashboard + Progress tab) and `utils/friendsEngine.js` |
| **Global metadata / tier lists (Solo/Flex/ARAM/Arena + pro builds)** | Curated/bundled in `shared/builds.js` + `shared/draftCoach.js`; your-own-data analytics in `utils/tftAnalyticsEngine.js` |

**Compliance note (Pillar 2):** **Global win-rate tier lists are not
compliantly obtainable** — that data is aggregated by scraping op.gg/u.gg, which
is off-limits. Riot exposes no tier-list/matchup endpoint. So this pillar ships
as **curated tables + mock schemas + your-own-match analytics**, never scraped
global stats.

---

## Pillar 3 — compliant in-game overlays

The overlay is a **separate, transparent, always-on-top, click-through Electron
window** (`main.createOverlay`) composited by the OS. It never injects into,
draws inside, reads from, or aligns to the League process. Click-through in Live
Mode = zero gameplay interference.

### Modular element isolation (4 decoupled trees)
- `mod-stats` — PEPSTATS panel (CSM/KP/KDA/LVL vs rank baseline + lane dossier)
- `mod-skill` — SKILL "Max Next" priority
- `mod-toasts` — TOASTS (multikill / objective highlights from your own event stream)
- **timer chips** — TIMERS, now one independent draggable chip per objective
  (Grubs/Herald/Dragon/Baron/Inhibs + static Camps/Scuttle)

All in `windows/ingame/{index.html, ingame.js, styles.css}`. Each is an
independent component tree; the drag engine is generic over modules and chips.

### Design Mode (Ctrl+Shift+D)
- Eye **hide/disable toggle on every module and every timer chip**.
- Disabling a module **unmounts it from live rendering** and saves to
  `config.json` → `ui.overlay.modules` (the TOASTS toggle fully suppresses the
  announcer popups). Per-chip hide + position persist to `localStorage`.

### Spatial map-overlay timers
Each objective countdown is a **raw, transparent, text-only block** in Live Mode,
independently draggable in Design Mode → the user places each clock over its spot
on their own minimap **by eye**. The app reads nothing from the game and never
detects/aligns to the minimap (that would require forbidden screen/memory reads).

### Persistence
| What | Where |
| --- | --- |
| Module positions/scale | `localStorage` `pep-overlay-modules` |
| Timer-chip positions + per-chip hide | `localStorage` `pep-overlay-timers` |
| Module visibility, overlay rows, theme | `config.json` `ui.overlay.{modules,rows}` |

### Additional overlays — scaffold status + compliance
| Feature | Status | Compliance |
| --- | --- | --- |
| Skill "Max Next" reposition | **Done** (draggable module) | ✅ |
| Gold-value inventory diff | Scaffold-ready | ✅ item gold values (ddragon) × `allPlayers` items (sanctioned) |
| Optimal jungle pathing guide | Scaffold-ready | ✅ curated/static advice |
| Ultimate cooldowns | Placeholder only | ⚠️ **manual** — enemy ult CDs are in no API; auto = CV/memory (forbidden); manual fights click-through |
| Trinket / Flash off-cooldown reminders | Placeholder only | ⚠️ **manual/timer** — same constraint |

---

## Release / build

Electron-builder NSIS installer. `.github/workflows/build.yml` builds on push to
`main` (windows-latest) → publishes to the rolling `latest` tag; per-version
tags via `scripts/release.js`. `npm run check` syntax-checks all source.
Runtime deps: `ws` only (no FFI / robotjs / opencv / memory tooling).
