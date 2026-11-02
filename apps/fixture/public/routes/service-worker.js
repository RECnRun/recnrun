import { onClick, show, start } from "../fixture.js";
import { CACHED_PATH, SOURCE_HEADER } from "../sw-cache.js";

async function control() {
  const { serviceWorker } = navigator;
  await serviceWorker.register("/sw.js", { type: "module" });
  if (!serviceWorker.controller) {
    await new Promise((resolve) => {
      serviceWorker.addEventListener("controllerchange", resolve, { once: true });
    });
  }
  show("sw-state", "controlled");
}

async function source() {
  const response = await fetch(CACHED_PATH);
  return response.headers.get(SOURCE_HEADER) ?? "network without the worker";
}

async function fetchTwice() {
  show("cache-result", "fetching");
  const first = await source();
  const second = await source();
  show("cache-result", `first: ${first}, second: ${second}`);
}

onClick("fetch-twice", "fetches", () => void fetchTwice());

await start("service-worker", { counters: ["fetches"], selfTest: control });
