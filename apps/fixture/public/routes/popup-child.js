import { onClick, show, start } from "../fixture.js";

onClick("close-window", "closes", () => window.close());

await start("popup-child", { counters: ["closes"] });
if (window.opener) {
  window.opener.postMessage({ type: "fixture-popup" }, location.origin);
  show("report", "Reported to the opener");
} else {
  show("report", "No opener");
}
