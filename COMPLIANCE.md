# PepStats — Riot / Vanguard Compliance

PepStats is built to be safe to run alongside League of Legends with **Riot
Vanguard** (the kernel-level anti-cheat) active. This document records exactly
what the app does and does not do, so the compliance posture is auditable.

## Why it's Vanguard-safe

Vanguard targets cheats that tamper with the game: kernel drivers, DLL
injection, function hooking, reading/writing the game's process memory, and
automating input into the client. **PepStats does none of these.** It is a
plain Electron (Chromium + Node) desktop app that only makes local/remote HTTP
requests and renders its own windows.

| Cheat technique Vanguard bans | Does PepStats do it? |
| --- | --- |
| Kernel driver / ring-0 access | **No** — it's a normal user-space app |
| DLL injection into the game | **No** |
| Function hooking / detours | **No** |
| Reading or writing game process memory | **No** — never touches the League process |
| Code injection / `CreateRemoteThread` etc. | **No** |
| Screen capture + computer vision of the game | **No** |
| Minimap/ward/fog-of-war reconstruction | **No** |
| Automating mouse/keyboard input into the game | **No** |
| Native addons / FFI / `node-gyp` modules | **No** — pure JS dependencies (only `ws`) |

A source audit confirms there are **no** calls to `keybd_event`, `SendInput`,
`mouse_event`, `ReadProcessMemory`, `WriteProcessMemory`, `CreateRemoteThread`,
`robotjs`, `ffi`, or any `.dll`/injection/hooking APIs anywhere in `src/`.

## What it actually reads (all sanctioned or tolerated)

1. **Live Client Data API** — `https://127.0.0.1:2999/liveclientdata` (HTTPS,
   self-signed). Riot's official in-game data endpoint. Powers CS, KDA, gold,
   and objective timers. Read-only.
2. **Riot Games API** — `https://*.api.riotgames.com` via the user's own
   personal key. Official, documented, read-only (rank, summoner, match
   history).
3. **LCU API** — `https://127.0.0.1:<port>` using the client's own lockfile for
   auth (read-only `flag:'r'`). A gray area Riot tolerates (Blitz, Mobalytics,
   etc. use it); PepStats keeps to **reads** (gameflow phase, champ-select
   session, `/lol-chat` friends presence, current summoner) plus exactly two
   tolerated write types — **rune pages** (`/lol-perks`) and **item sets**
   (`/lol-item-sets`). No queue auto-accept, no champ-select pick/ban automation,
   no dodge, no lobby manipulation.
4. **Data Dragon / CommunityDragon** — static, public CDN assets (champion,
   item, rune, and rank-emblem images). No auth, no game data.
5. **Spectator API** (`spectator-v5`) — a friend's active game is read as
   **draft only** (champions, summoner spells, bans). The API exposes no live
   items / gold / KDA / events, and PepStats invents none.

## The overlay is not injected

The in-game overlay is a **separate, transparent, always-on-top Electron
window** composited by the OS — the same approach OBS, Discord's
non-injected overlay, and accessibility tools use. It does **not** inject into,
draw inside, or read from the League process. It is click-through during a match
so it never intercepts game input.

## Input

The app registers global hotkeys (Ctrl+Shift+D/H/1/2/3/Q) via Electron's
`globalShortcut` — standard OS-level shortcut registration. It never synthesizes
or automates input into the game.

## Where we deliberately stop (the compliant line for "tempting" features)

Several requested features sit next to a forbidden technique. We build only the
side of each line that uses sanctioned data — the other side would require
screen-reading or memory access, which we never do:

| Feature | Compliant version we allow | Forbidden version we refuse |
| --- | --- | --- |
| Jungle camp timers | **Static** spawn schedule from the game clock | Live per-camp "cleared" tracking (needs CV/memory — no API signal exists) |
| Enemy summoner-spell cooldowns | **Nothing.** Removed in 0.5.11 — Riot's third-party policy forbids "tracking of enemy summoner spells cooldowns, **or facilitating players tracking these with timers**", so even a hand-driven stopwatch is out | Any flash timer, manual or automatic |
| Enemy ultimate availability | **Nothing.** Removed in 0.5.11 — Riot banned enemy **ultimate timers** outright in third-party apps (policy update effective 2025-03-13; Porofessor was required to remove the same feature) | Any enemy ult timer, manual or automatic |
| Team / enemy gold differential | **Post-game** from your own match-v5 timeline | A live enemy-gold readout (the live feed exposes only *your* gold) |
| Spectator highlight feed | Your **own** Live Client event stream | A live kill/event feed for a friend's spectated game (spectator API is draft-only) |
| Lane-opponent comparison | **In-game** from the sanctioned `allPlayers` feed | Pre-game enemy stats (enemy identities are hidden in champ select) |

Reading every player's KDA/CS/level/items from the official `allPlayers` feed is
compliant — it's the same data the in-game Tab scoreboard already shows; it is
**not** the bannable minimap-CV maphack.

**Removed feature — a compliance lesson (0.5.11).** Versions 0.5.4–0.5.10
shipped manual, hotkey-driven Enemy-Flash and Enemy-Ult trackers, reasoned from
the *technical* layer: input flowed user → app (`globalShortcut`), nothing
detected the cast, nothing touched the game. That reasoning is necessary but
**not sufficient** — Riot's third-party policy bans *feature categories*
regardless of implementation. Enemy **ultimate timers** are "strictly forbidden"
(policy update effective 2025-03-13), and the policy also prohibits "tracking of
enemy summoner spells cooldowns, **or facilitating players tracking these with
timers**" — which describes a manual tracker exactly. Both modules, their
hotkeys, the IPC channels, and the `enemyRoster` helper were removed in 0.5.11.
The rule going forward: a feature must clear **both** tests — technically clean
(no memory/screen/input) *and* explicitly permitted by Riot's written policy.

## Riot policy parse — feature-by-feature (2026-06-10, v0.6.0 "SwissCheese")

Riot's written third-party rules (developer policies + the platform compliance
doc approved apps operate under) were parsed in full and every PepStats feature
was judged against them. The rules that bind us, and our status:

| Riot rule (near-verbatim) | PepStats feature affected | Action |
| --- | --- | --- |
| Enemy **ultimate timers** are strictly forbidden | Enemy Ults tracker | **Removed (0.5.11)** |
| No tracking of enemy **summoner-spell cooldowns**, "or facilitating players tracking these with timers" | Enemy Flash tracker | **Removed (0.5.11)** |
| No notifications that **dictate player action** from the current game state (e.g. gank suggestions) | objectiveRotator — "X spawning in 30s — set up vision and prep your recall/wave" | **Removed (0.6.0)** — the passive timer chips already show spawn countdowns with no prescription |
| No alerts on enemy **power spikes** (e.g. "X hit level 6"); no action-dictating output | liveCombatEngine — "priority target" threat ranking + "fed" flags | **Removed (0.6.0)** — naming a priority target dictates action; the factual Tab data it reformatted remains visible via the lane dossier |
| **Champ-select anonymity**: non-party summoner names must be replaced with neutral designations ("Ally 1…") in lobby/draft displays | Pre-game ally recent-form showed ally Riot IDs | **Anonymized (0.6.0)** — every non-self ally now renders as "Ally N"; the form stats stay, the identity does not |
| TFT: no displaying **augment win rates** or **augment average placements** | TFT analytics "augment performance matrix" (avg placement + top-4 rate per augment) | **Removed (0.6.0)** — even own-match-derived augment tables are the banned shape |
| No aggregating or displaying **Brawl** match-history data | Match history / summaries could include queue 480 | **Excluded (0.6.0)** — Brawl games are dropped from every list and aggregate |
| No deanonymization, scripting, automation, memory reads, screen capture, fog-of-war info | — | Never present (see Audit) |

Features re-verified as **allowed** under the same parse: own-performance
overlay stats + rank-baseline comparison, CSM sparkline/pace pip, own skill
hint, lane dossier (passive Tab-visible data, no alerts), highlight toasts (own
milestones only — celebration, not direction), static camp/scuttle schedule and
objective/inhib respawn timers (the native HUD shows these), gold-value item
diff (arithmetic on Tab-visible items; appears in no prohibition), curated
draft coach (static knowledge, champ-select-stage advice like every approved
app), rune/item-set import (the two tolerated LCU writes), Friends tab (LCU
presence + official API), spectator draft view, TFT match history (placements,
comps, units — not augment/legend stat tables), AI coach on the user's own key.

## Audit

Last full-tree audit (**2026-06-10**, adversarial): pattern scan (no `opencv`/
`robotjs`/`ffi`/`memoryjs`/`ReadProcessMemory`/`SendInput`/`desktopCapturer`/
screen-capture/`eval`/`/actions`/matchmaking-automation anywhere), a full
enumeration of every outbound host (only `127.0.0.1:2999`, the LCU lockfile
port, `*.api.riotgames.com`, `ddragon.leagueoflegends.com`,
`raw.communitydragon.org`, `api.anthropic.com` with the user's own key, and the
optional user-configured baseline URL — zero third-party stat sites), the
complete LCU write surface (rune pages + item sets only), every
`child_process` call (`tasklist`/`pgrep` process detection and a read-only
`reg query` for install discovery — nothing executes or injects), and the
dependency tree (`ws` is the only runtime dep). **Verdict: clean** — no
violations at any severity.

**Policy addendum (2026-06-10, same day):** the manual Enemy-Flash/Ult trackers
— technically clean per the audit above — were nonetheless **removed in 0.5.11**
after checking Riot's written third-party policy: enemy ultimate timers are
banned outright (2025-03-13 enforcement), and facilitating enemy summoner-spell
cooldown tracking with timers is prohibited even when manual. Earlier installers
(0.5.4–0.5.10) contain the feature; do not redistribute them.

---

If Riot's policies change, the guiding rule stays the same: **only read
sanctioned data, never touch the game process, never automate gameplay.**
