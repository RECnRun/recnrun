import { byTestId, count, show, start } from "../fixture.js";

// The late button appears after this delay, so replay must find it by polling.
const LATE_MS = 1_500;
const query = new URLSearchParams(location.search);

byTestId("search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") show("search-status", `Searched ${event.target.value}`);
});

byTestId("terms").addEventListener("change", (event) => {
  byTestId("continue").disabled = !event.target.checked;
});

byTestId("continue").addEventListener("click", () => {
  byTestId("done-panel").hidden = false;
  byTestId("intro").hidden = true;
});

byTestId("open-popup").addEventListener("click", () => {
  window.open("/routes/submit-result?name=Popup", "_blank");
});

addEventListener("scroll", () => show("scroll-y", `Scrolled ${Math.round(scrollY)}`));

setTimeout(() => {
  const late = document.createElement("button");
  late.type = "button";
  late.dataset.testid = "late";
  late.textContent = "Late button";
  late.addEventListener("click", () => show("late-status", `Late clicked ${count("lateClicks")}`));
  byTestId("late-slot").append(late);
}, LATE_MS);

// The order form posts this key; the server counts orders per key and answers after `delay` ms.
byTestId("order-key").value = query.get("order") ?? "default";
byTestId("order-delay").value = query.get("delay") ?? "0";
const placed = query.get("placed");
if (placed) show("order-status", `Order ${placed} placed`);

await start("replay", { counters: ["lateClicks"] });
