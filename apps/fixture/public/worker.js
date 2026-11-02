// A module dedicated worker: announces itself once, then answers every message.
import { WORKER_MESSAGE } from "./worker-message.js";

self.postMessage({ type: WORKER_MESSAGE, text: "started" });
self.addEventListener("message", (event) => {
  self.postMessage({ type: WORKER_MESSAGE, text: `pong to ${String(event.data)}` });
});
