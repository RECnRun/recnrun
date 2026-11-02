import { byTestId, count, show, start } from "../fixture.js";

const same = byTestId("frame-same");
const cross = byTestId("frame-cross");

window.addEventListener("message", (event) => {
  if (event.data?.type !== "fixture-child") return;
  count("messages");
  // The browser sets event.origin, so the child cannot claim another one.
  show(event.source === same.contentWindow ? "origin-same" : "origin-cross", event.origin);
});

async function loadChildren() {
  const config = await (await fetch("/api/config")).json();
  same.src = "/routes/iframe-child";
  // Another host name makes the child cross-site, so Chrome puts it in its own process.
  cross.src = `${config.secondOrigin}/routes/iframe-child`;
}

await start("iframe", { counters: ["messages"], selfTest: loadChildren });
