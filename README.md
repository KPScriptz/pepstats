# PepStats — Your League of Legends Companion & AI Coach

**Climb smarter. PepStats follows you from champ select to the post-game screen —
giving you the right stats at the right moment, measured against your _rank_, not
a random opponent.**

PepStats is a lightweight Windows companion for League of Legends that runs
alongside the game with near-zero performance impact. It links to your Riot
account, surfaces a clean in-game overlay, and turns every match into a coaching
opportunity — all while staying fully within Riot's Terms of Service.

## What it does

- 🎮 **In-Game Overlay** — A sleek, click-through HUD showing your CS/min, KP%,
  KDA, and level **compared to the average player at your rank**, so you always
  know if you're ahead or behind for your elo. Objective timers (Grubs, Herald,
  Dragon, Baron) are computed from the live game clock.
- 🧭 **Game-Mode Aware** — Detects Summoner's Rift vs. ARAM and adapts: no
  phantom jungle objectives in ARAM, role-appropriate stats everywhere.
- 🏠 **Home Client** — A desktop hub showing your rank progression to the next
  tier, weekly LP gain, account level, win rate, and recent form — even when the
  League client is closed.
- 🤖 **AI Rank-Up Forecast** — Powered by Claude: a realistic estimate of how
  fast you can climb (e.g. Silver → Gold) at your current pace, plus the win rate
  you'd need to go faster.
- 📊 **AI Post-Game Coach** — After every match, a concise tactical review of
  _your own_ play: wave management, recall timing, objective routing, with
  specific fixes.
- 🔗 **Riot Account Linking** — Connect once with your Riot ID and a free
  personal API key; your stats sync automatically.

## Safe by design

PepStats reads **only Riot-sanctioned data** — the official Live Client Data API,
the LCU, and the Riot Games API. **No screen capture. No minimap vision. No enemy
tracking.** Nothing that risks your account.

---

## Download & run (Windows)

1. Open the **[Releases](../../releases)** page → **Latest build**.
2. Download **`PepStats-Setup-x.y.z.exe`** and run it.

> Builds are currently **unsigned**, so SmartScreen shows *"Windows protected
> your PC / unknown publisher"* → **More info → Run anyway**. (See
> [SIGNING.md](SIGNING.md) for the code-signing roadmap.)

## First run — connect your Riot account

On first launch PepStats asks you to link your account so it can show your stats
even when the League client is closed:

1. Open **developer.riotgames.com** → **Sign in with Riot**.
2. **Register Product → Personal API Key** (a personal key does **not** expire).
3. In PepStats: enter your **Riot ID** (`Name#Tag`), pick your **region**, paste
   the **key**, and click **Connect account**.

Prefer not to link? Choose **Use League client only** — PepStats will read your
signed-in account locally whenever the League client is open.

## Controls

| Shortcut | Action |
| --- | --- |
| **Ctrl + Shift + D** | Overlay: toggle Design Mode (drag to reposition) ⇄ Live Mode (click-through) |
| **Ctrl + Shift + H** | Show the Home client window |
| **Ctrl + Shift + 1 / 2 / 3** | Manually show Pre-Game / In-Game / Post-Game (testing) |
| **Ctrl + Shift + Q** | Quit |

PepStats switches automatically: champ select → Pre-Game, live match → In-Game
overlay, match end → Post-Game review, otherwise → the Home client.

## What it reads (and what it deliberately does NOT)

- ✅ **Live Client Data API** (`https://127.0.0.1:2999`) — Riot-sanctioned.
  Powers CS, CS/min, gold, and objective timers (from the game clock + events).
- ✅ **Riot Games API** — your rank, summoner level, and ranked record via your
  own personal API key (Riot ID → PUUID → summoner → league).
- 🟡 **LCU API** — champ-select detection, the signed-in account's live data, and
  rune import. Tolerated by Riot but not officially supported; reads + standard
  rune-page writes only.
- ❌ **No screen capture, no minimap computer vision, no enemy tracking.** That
  category is a map-hack under Riot's ToS, gives an unfair advantage, and is
  detected by Vanguard → account bans.

## AI setup

The Post-Game coach and the Rank-Up Forecast use the Claude API. Add your
Anthropic API key in the app's **Settings** card (or copy `config.example.json`
to `config.json` and fill it in). Your match summary is sent to Claude and the
response is shown in-app.

## Project structure

```
pepstats/
├── build/icon.ico               # app icon (window, taskbar, installer)
├── package.json                 # electron-builder: nsis installer + extraResources
├── .github/workflows/build.yml  # builds the Windows installer, publishes to Releases
├── SIGNING.md                   # code-signing options (env-var / Azure / self-signed)
├── config.example.json          # copy to config.json for the AI key
├── src/
│   ├── main.js                  # window state machine, shortcuts, AI, IPC
│   ├── preload.js               # contextBridge API (role-aware)
│   ├── shared/
│   │   ├── liveClient.js        # Live Client Data API + rank-baseline comparison
│   │   ├── rankBaseline.js      # per-rank stat baselines (external API + fallback)
│   │   ├── rankProgress.js      # rank/LP math + local weekly-LP tracking
│   │   ├── riotApi.js           # official Riot Games API client
│   │   ├── lcu.js               # LCU connector (gray area)
│   │   └── timers.js            # mode-aware objective timers
│   └── windows/
│       ├── home/                # the desktop client (ranked progress, AI, settings)
│       ├── ingame/              # transparent click-through overlay
│       ├── pregame/             # champ-select dashboard
│       └── postgame/            # review + AI coach
└── backend/                     # OPTIONAL compliant Python sidecar
```

## Local development (needs Node.js)

```bash
npm install
npm start        # launches PepStats
npm run dist     # builds the Windows installer (run on Windows)
```

## License

MIT
