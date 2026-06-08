"use strict";

/*
 * Champion Sync theme engine.
 *
 * Dynamically tints the app's --accent-dynamic / --accent-dynamic-glow root
 * variables to match the champion the player has selected. Loaded as a plain
 * script in any renderer that wants the effect (pregame, in-game overlay, home).
 *
 * Public surface:
 *   window.syncAppTheme(championName, isSyncEnabled)
 *   window.PepThemeEngine.CHAMPION_THEMES
 *
 * The toggle state lives in the shared theme payload as `championSync`
 * (window.__pepTheme.championSync), wired to the `championSyncEnabled` setting.
 */

(function () {
  // Default identity: Hextech blue. Used when sync is off or the champion is
  // unknown / has no mapping.
  const DEFAULT_THEME = { accent: "#0070f3", glow: "rgba(0, 112, 243, 0.15)" };

  // hex -> "r, g, b" for building an rgba() glow at a fixed alpha.
  function glowFor(hex, alpha) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
    if (!m) return DEFAULT_THEME.glow;
    const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha == null ? 0.18 : alpha})`;
  }

  // Champion -> signature accent. Keyed by Data Dragon display name. The glow is
  // derived from the accent so every entry stays consistent.
  const ACCENTS = {
    Thresh: "#1fd6b6",        // teal lantern
    Vladimir: "#c01f3a",      // crimson
    Jinx: "#ff3fa4",          // hot pink
    Garen: "#e7b53c",         // gold / amber
    Lux: "#ffd86b",           // radiant gold
    Ahri: "#ff5fb0",          // charm pink
    Yasuo: "#3fb6ff",         // wind blue
    Zed: "#e23a55",           // shadow red
    Ekko: "#39e0c8",          // chrono teal
    Vi: "#ff7a3c",            // gauntlet orange
    Caitlyn: "#d79a3c",       // sheriff gold
    Ashe: "#7fd0ff",          // frost blue
    MissFortune: "#ff5d6c",   // bounty red
    Vayne: "#8a6bff",         // night-hunter violet
    Neeko: "#46c98a",         // chameleon green
    Darius: "#c8334a",        // noxus red
    Sett: "#ff5a3c",          // boss orange
    Malphite: "#7a8aa0",      // stone slate
    Mordekaiser: "#6f3cff",   // death violet
    Warwick: "#9aa7b8",       // blood-hunt grey-blue
    JarvanIV: "#e7b53c",      // demacia gold
    "Jarvan IV": "#e7b53c",
    NunuWillump: "#5fb6ff",
    "Nunu & Willump": "#5fb6ff",
    MasterYi: "#ffcf5f",
    "Master Yi": "#ffcf5f",
    Annie: "#ff7a3c",
    Veigar: "#a06bff",
    Malzahar: "#7a3cff",
    Lulu: "#b07bff",
    Soraka: "#9fd6ff",
    Leona: "#e7b53c",
    Nautilus: "#3fa0d6",
    Janna: "#bfeaff",
    Sivir: "#e7b53c",
  };

  const CHAMPION_THEMES = {};
  for (const name of Object.keys(ACCENTS)) {
    CHAMPION_THEMES[name] = { accent: ACCENTS[name], glow: glowFor(ACCENTS[name]) };
  }

  let current = "";

  function setVars(theme) {
    const r = document.documentElement;
    r.style.setProperty("--accent-dynamic", theme.accent);
    r.style.setProperty("--accent-dynamic-glow", theme.glow);
  }

  // Normalize "Miss Fortune" / "missfortune" -> a CHAMPION_THEMES key.
  function lookup(name) {
    if (!name) return null;
    if (CHAMPION_THEMES[name]) return CHAMPION_THEMES[name];
    const squashed = String(name).replace(/[^a-z]/gi, "").toLowerCase();
    for (const key of Object.keys(CHAMPION_THEMES)) {
      if (key.replace(/[^a-z]/gi, "").toLowerCase() === squashed) return CHAMPION_THEMES[key];
    }
    return null;
  }

  function syncAppTheme(championName, isSyncEnabled) {
    const theme = (isSyncEnabled && lookup(championName)) || DEFAULT_THEME;
    const key = (isSyncEnabled ? championName : "") + "|" + theme.accent;
    if (key === current) return theme; // no-op if unchanged
    current = key;
    setVars(theme);
    return theme;
  }

  window.PepThemeEngine = { CHAMPION_THEMES, DEFAULT_THEME, syncAppTheme };
  window.syncAppTheme = syncAppTheme;

  // Re-evaluate when the toggle flips while a champion is already showing.
  document.addEventListener("pep-champion", (e) => {
    const enabled = !(window.__pepTheme && window.__pepTheme.championSync === false);
    syncAppTheme(e && e.detail, enabled);
  });
})();
