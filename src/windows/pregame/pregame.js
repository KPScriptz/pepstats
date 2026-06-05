"use strict";

document.getElementById("close").addEventListener("click", () => window.close());

const phaseEl = document.getElementById("phase");
const allyEl = document.getElementById("ally");
const enemyEl = document.getElementById("enemy");
const importStatus = document.getElementById("import-status");

function renderTeam(el, members) {
  if (!members || !members.length) return;
  el.innerHTML = "";
  for (const m of members) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.textContent = m.assignedPosition || "—";
    const champ = document.createElement("span");
    champ.textContent = m.championId ? "Champion #" + m.championId : "picking…";
    row.append(name, champ);
    el.append(row);
  }
}

async function refresh() {
  const session = await window.pepstats.getPregame();
  if (!session) {
    phaseEl.textContent = "League client not detected. Open League on this PC and enter champ select.";
    return;
  }
  phaseEl.textContent = "Champ select in progress.";
  renderTeam(allyEl, session.myTeam);
  renderTeam(enemyEl, session.theirTeam);
}

document.getElementById("import").addEventListener("click", () => {
  // Rune import would POST a rune page to the LCU here. Left as an explicit
  // opt-in stub — wire src/shared/lcu.request("/lol-perks/v1/pages", ...) when ready.
  importStatus.textContent = "Rune import is stubbed — see src/shared/lcu.js.";
});

refresh();
setInterval(refresh, 3000);
