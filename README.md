# PepStats

A League of Legends companion: a **Pre-Game** draft dashboard, a transparent
click-through **In-Game** overlay, and a **Post-Game** AI coach — built on
Electron, shipped as a single Windows installer built automatically by GitHub
Actions.

## Download & run (Windows)

1. Open the **[Releases](../../releases)** page → **Latest build**.
2. Download **`PepStats-Setup-x.y.z.exe`** and run it (SmartScreen is unsigned →
   *More info → Run anyway*).

## Controls

| Shortcut | Action |
| --- | --- |
| **Ctrl + Shift + D** | Overlay: toggle Design Mode (drag the gold title) ⇄ Live Mode (click-through) |
| **Ctrl + Shift + 1 / 2 / 3** | Manually show Pre-Game / In-Game / Post-Game window (useful for testing) |
| **Ctrl + Shift + Q** | Quit |

Normally PepStats switches windows automatically: champ select → Pre-Game,
live match → In-Game overlay, match end → Post-Game review.

## What it reads (and what it deliberately does NOT)

- ✅ **Live Client Data API** (`https://127.0.0.1:2999`) — Riot-sanctioned.
  Powers CS, CS/min, gold, and the objective timers (computed from the game
  clock + kill events).
- 🟡 **LCU API** — champ-select detection and rune import. Tolerated by Riot but
  not officially supported; kept to reads / standard rune-page writes.
- ❌ **No screen capture, no minimap computer vision, no enemy tracking.** That
  category is a map-hack under Riot's Terms of Service, gives an unfair
  advantage, and is detected by Vanguard (kernel anti-cheat) → account bans. The
  "jungle helper" here is objective/camp **timers from the sanctioned API only**.

## AI coach setup

Copy `config.example.json` to `config.json` (gitignored) and add your Anthropic
API key. The Post-Game window's *Get Tactical Review* button sends **your own**
match summary to Claude and shows the coaching response.

## Project structure

```
pepstats/
├── package.json                 # electron-builder: nsis installer + extraResources
├── .github/workflows/build.yml  # builds the Windows installer, publishes to Releases
├── config.example.json          # copy to config.json (gitignored) for the AI key
├── src/
│   ├── main.js                  # window state machine, shortcuts, AI coach
│   ├── preload.js               # contextBridge API (role-aware)
│   ├── shared/
│   │   ├── liveClient.js        # Live Client Data API (sanctioned)
│   │   ├── lcu.js               # LCU connector (gray area)
│   │   └── timers.js            # objective timers from game clock + events
│   └── windows/
│       ├── ingame/              # transparent click-through overlay
│       ├── pregame/             # charcoal champ-select dashboard
│       └── postgame/            # charcoal review + AI coach
└── backend/                     # OPTIONAL compliant Python sidecar
    ├── main.py                  # Live Client poller (stdlib only, no CV)
    ├── pepstats_backend.spec    # PyInstaller -> backend/dist/pepstats-backend.exe
    └── dist/                    # extraResources packs this into the installer
```

## The Python sidecar (optional)

The app runs fully on Node. The Python backend is included to demonstrate the
`extraResources` packaging path and is **disabled in CI by default** so it can't
break the installer build. To enable it, uncomment the Python steps in
`.github/workflows/build.yml`; `backend/dist/pepstats-backend.exe` is then packed
into the installer under `resources/backend/` via this `package.json` block:

```json
"extraResources": [
  { "from": "backend/dist", "to": "backend", "filter": ["**/*"] }
]
```

## Local development (needs Node.js)

```bash
npm install
npm start        # launches PepStats (overlay starts in Design Mode)
npm run dist     # builds the Windows installer (run on Windows)
```
