import { count, onClick, show, start } from "../fixture.js";

onClick("open-popup", "opens", () => {
  window.open("/routes/popup-child", "fixture-popup", "popup,width=480,height=360");
});

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.type !== "fixture-popup") return;
  count("reports");
  show("popup-report", `Popup ready at ${event.origin}`);
});

await start("popup", { counters: ["opens", "reports"] });
