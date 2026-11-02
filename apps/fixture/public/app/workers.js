import { attempt, firstPaint, marker, show } from "./page.js";

await marker("workers:start");

const type = new URLSearchParams(location.search).get("type") === "module" ? "module" : "classic";

function firstMessage(target) {
  return new Promise((resolve, reject) => {
    target.addEventListener("message", (event) => resolve(event.data), { once: true });
    target.addEventListener("error", () => reject(new Error("worker failed to start")), {
      once: true,
    });
    setTimeout(() => reject(new Error("no report within 10 s")), 10_000);
  });
}

// Workers report after their first request has been answered, so the first-paint marker follows it.
const report = {
  type,
  dedicated: await attempt(() => firstMessage(new Worker(`/worker.js?type=${type}`, { type }))),
  shared: await attempt(() => {
    const worker = new SharedWorker(`/shared-worker.js?type=${type}`, { type });
    worker.port.start();
    return firstMessage(worker.port);
  }),
};

show("report", report);
await firstPaint("workers");
