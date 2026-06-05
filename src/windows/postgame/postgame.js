"use strict";

document.getElementById("close").addEventListener("click", () => window.close());

const out = document.getElementById("coach-out");
const coachBtn = document.getElementById("coach");

function fillCards(s) {
  const set = (id, v) => (document.getElementById(id).textContent = v);
  if (!s) {
    set("c-champ", "No game");
    return;
  }
  set("c-champ", s.champion || "—");
  set("c-kda", `${s.kda.k}/${s.kda.d}/${s.kda.a}`);
  set("c-cs", Math.round(s.cs).toString());
  set("c-cspm", s.csPerMin.toFixed(1));
  set("c-gold", Math.round(s.gold).toLocaleString());
  set("c-dur", Math.floor(s.gameTime / 60) + " min");
}

coachBtn.addEventListener("click", async () => {
  coachBtn.disabled = true;
  out.textContent = "Analyzing your match…";
  const res = await window.pepstats.requestCoach();
  out.textContent = res.text;
  coachBtn.disabled = false;
});

(async () => {
  fillCards(await window.pepstats.getLastGame());
})();
