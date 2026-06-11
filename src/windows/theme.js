"use strict";

// Shared theme applier — loaded by both the home client and the overlay.
// Reads the resolved theme from main and applies it via CSS custom properties +
// data attributes, then listens for live updates. Exposes window.__pepTheme for
// renderers that need the current values (e.g. the overlay's row toggles).

(function () {
  const api = window.pepstats || {};
  window.__pepTheme = null;

  function apply(t) {
    if (!t) return;
    window.__pepTheme = t;
    const r = document.documentElement;
    r.setAttribute("data-theme", t.theme === "light" ? "light" : "dark");
    r.setAttribute("data-density", t.density === "compact" ? "compact" : "comfortable");
    r.setAttribute("data-cb", t.colorblind === true ? "on" : "off");
    r.style.setProperty("--accent", t.accent || "#ff004c");
    r.style.setProperty("--ui-scale", String(t.fontScale || 1));
    if (t.overlay) {
      r.style.setProperty("--ov-scale", String(t.overlay.scale || 1));
      r.style.setProperty("--ov-opacity", String(t.overlay.opacity != null ? t.overlay.opacity : 1));
    }
    // Let window-specific code react (e.g. overlay re-render with new row prefs).
    document.dispatchEvent(new CustomEvent("pep-theme", { detail: t }));
  }

  if (api.onTheme) api.onTheme(apply);
  if (api.getTheme) api.getTheme().then(apply).catch(() => {});
})();
