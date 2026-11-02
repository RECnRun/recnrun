import { count, onClick, show, start } from "../fixture.js";
import { WORKER_MESSAGE } from "../worker-message.js";

// Kept for the page's lifetime, so the worker target stays alive while a test inspects it.
const worker = new Worker("/worker.js", { type: "module" });

worker.addEventListener("message", (event) => {
  if (event.data?.type !== WORKER_MESSAGE) return;
  count("replies");
  show("worker-reply", `Worker replied: ${event.data.text}`);
});

function firstReply() {
  return new Promise((resolve, reject) => {
    worker.addEventListener("message", resolve, { once: true });
    worker.addEventListener("error", () => reject(new Error("The worker failed to start")), {
      once: true,
    });
  }).then(() => show("worker-state", "running"));
}

onClick("ping-worker", "pings", () => worker.postMessage("ping"));

await start("worker", { counters: ["pings", "replies"], selfTest: firstReply });
