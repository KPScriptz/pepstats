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
   auth. A gray area Riot tolerates (Blitz, Mobalytics, etc. use it); PepStats
   keeps to **reads** plus standard rune-page writes only — no gameplay
   automation.
4. **Data Dragon / CommunityDragon** — static, public CDN assets (champion,
   item, rune, and rank-emblem images). No auth, no game data.

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

---

If Riot's policies change, the guiding rule stays the same: **only read
sanctioned data, never touch the game process, never automate gameplay.**
