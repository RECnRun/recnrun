import type { E1Browser } from "./experiments/e1-aggregate.ts";
import { REFUSAL } from "./experiments/e7-samples.ts";
import type { E7Sample } from "./experiments/e7-samples.ts";

// Samples the E7 unit tests vary: a marked storage page and a blob-wrapped dedicated worker.
export const CHROME: E1Browser = {
  chrome: "Google Chrome 156.0.8078.79",
  method: "cdp-load-unpacked",
};
export const APP = "http://app.localhost:4600";
export const START = "/__marker?name=storage%3Astart";
export const ME = "/me";
export const WORKER = "/worker.js?type=classic";
export const WORKER_ME = `/me?from=${encodeURIComponent(WORKER)}`;
export const BLOB_FROM = `${APP}/0b6f2c1e-uuid`;
export const THROWN = `error: SecurityError: ${REFUSAL} new Worker(${WORKER}): no wrapper keeps the worker's own self.location, baseURI, and relative imports`;

export function page(overrides: Partial<E7Sample> = {}): E7Sample {
  const marker = overrides.marker ?? "slot-3";
  return {
    hypothesis: "page",
    variant: "/storage.html",
    marker,
    expect: "marked",
    start: `${START}&__rec=${marker}`,
    effects: [`${ME}?__rec=${marker}`, `/__marker?name=storage%3Afirst-paint&__rec=${marker}`],
    store: "fixture-page",
    inventory: {
      indexedDB: [`__rec:${marker}:fixture-page`],
      cacheStorage: [`__rec:${marker}:fixture-page`],
      localStorage: ["fixture:user"],
      sessionStorage: [],
    },
    ...overrides,
  };
}

export function worker(
  overrides: Partial<E7Sample> = {},
  report: unknown = { user: "alice" },
): E7Sample {
  return {
    hypothesis: "dedicated-worker",
    variant: "blob/classic",
    marker: "slot-1",
    expect: "marked",
    effects: [`${WORKER_ME}&__rec=slot-1`],
    store: "fixture-dedicated",
    inventory: {
      indexedDB: ["__rec:slot-1:fixture-dedicated"],
      cacheStorage: ["__rec:slot-1:fixture-dedicated"],
    },
    worker: { script: WORKER, from: WORKER, report },
    ...overrides,
  };
}
