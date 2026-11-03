import type { Page } from "@playwright/test";
import type { LoadedExtension } from "../browser/fixtures/extension.ts";
import { attributeWorkers, realmPaths } from "./e7-samples.ts";
import type { E7Sample, WorkerRealm } from "./e7-samples.ts";
import type { IdentitySample } from "./e7-summary.ts";
import {
  API,
  APP,
  IDP,
  REPORT_TIMEOUT_MS,
  checkpoint,
  closeAndSettle,
  evaluate,
  expect,
  fromOf,
  inventoryOf,
  ledger,
  markerSeen,
  reportOf,
  sharedWorkersLeft,
  tabOf,
} from "./page-loads.ts";
import type { Run } from "./page-loads.ts";

// One load of E7: a new tab, the Route C slot it starts under, and what the ledger and stores kept.
const ROUTE_C = "globalThis.recnrunRouteC";
const BLANK = "about:blank#recnrun-e7";
// Base 36 has no 32-hex run, which the evidence redaction would hash.
const RUN = Date.now().toString(36);
const SESSION = `e7-${RUN}`;
const IDP_MATCH = `${IDP}/*`;
const APP_MATCHES = ["http://app.localhost:4600/*", "http://app.localhost:4603/*"];

export type Strategy = "fail-closed" | "blob" | "data";
export type Reach = "app-only" | "with-idp";

/** Calls Route C in the isolator's service worker. */
export function routeC<T>(extension: LoadedExtension, call: string): Promise<T> {
  return evaluate<T>(extension, `${ROUTE_C}.${call}`);
}

/** Registers Route C for the app origins, and the IdP's when `reach` says so. */
export function install(extension: LoadedExtension, workers: Strategy, reach: Reach = "app-only") {
  const matches = reach === "with-idp" ? [...APP_MATCHES, IDP_MATCH] : APP_MATCHES;
  return routeC<string>(
    extension,
    `install(${JSON.stringify({ marker: SESSION, workers, matches })})`,
  );
}

function nextSlot(extension: LoadedExtension): Promise<string> {
  return routeC<string>(extension, `setMarker(${JSON.stringify({ marker: SESSION })})`);
}

let tabs = 0;

/** A new tab Route A knows by id, so the load's origin can be cleared afterwards. */
async function openTab(run: Run): Promise<{ page: Page; tabId: number }> {
  const page = await run.context.newPage();
  tabs += 1;
  return { page, tabId: await tabOf(run.extension, page, `${BLANK}-${RUN}-${tabs}`) };
}

/** Clears what the load stored on the app origin, then closes its tabs; the last close waits. */
async function finish(run: Run, ...tabs: { page: Page; tabId: number }[]) {
  for (const { tabId } of tabs) {
    await evaluate(run.extension, `globalThis.recnrunRouteA.clearOrigin({ tabId: ${tabId} })`);
  }
  for (const { page } of tabs.slice(0, -1)) await page.close();
  const last = tabs.at(-1);
  if (last) await closeAndSettle(run, last.page);
}

const PAGES: Record<string, { name: string; store?: string }> = {
  "/": { name: "index" },
  "/storage.html": { name: "storage", store: "fixture-page" },
};

/** `path` under a fresh slot: its start marker, later fetches, and the stores it left. */
export async function pageSample(run: Run, path: string): Promise<E7Sample> {
  const { name, store } = PAGES[path] ?? { name: "unknown" };
  const marker = await nextSlot(run.extension);
  const tab = await openTab(run);
  const since = await checkpoint();
  await tab.page.goto(`${APP}${path}`);
  await markerSeen(since, `${name}:first-paint`);
  const inventory = await inventoryOf(run, tab.page, marker);
  const paths = realmPaths(await ledger(since), `${name}:start`, [APP, API]);
  await finish(run, tab);
  const base = { hypothesis: "page", variant: path, marker, expect: "marked" as const };
  return { ...base, ...paths, ...(store ? { store } : {}), ...(inventory ? { inventory } : {}) };
}

const STORES: Record<WorkerRealm, string> = {
  dedicated: "fixture-dedicated",
  shared: "fixture-shared",
};

/** Both workers of `workers.html?type=<type>` under a fresh slot, wrapped the installed way. */
export async function workerSamples(run: Run, strategy: Strategy, type: string) {
  const marker = await nextSlot(run.extension);
  const tab = await openTab(run);
  const since = await checkpoint();
  const report = (await reportOf(tab.page, `${APP}/workers.html?type=${type}`)) as Record<
    string,
    unknown
  >;
  await markerSeen(since, "workers:first-paint");
  const inventory = await inventoryOf(run, tab.page, marker);
  const requests = (await ledger(since)).filter((entry) => entry.origin === API);
  await finish(run, tab);
  const scripts = {
    dedicated: `/worker.js?type=${type}`,
    shared: `/shared-worker.js?type=${type}`,
  };
  const owned = attributeWorkers(
    requests.map((entry) => entry.path),
    scripts,
    report,
  );
  return (["dedicated", "shared"] as const).map((realm): E7Sample => {
    const path = owned[realm];
    return {
      hypothesis: `${realm}-worker`,
      variant: `${strategy}/${type}`,
      marker,
      expect: "marked",
      effects: path ? [path] : [],
      store: STORES[realm],
      ...(inventory ? { inventory } : {}),
      worker: {
        script: scripts[realm],
        from: fromOf(path ?? "") ?? undefined,
        report: report[realm],
      },
    };
  });
}

/** Whether the opener's `#log` shows `text` within the report timeout. */
async function logShows(page: Page, text: string): Promise<boolean> {
  const shown = () => page.locator("#log").textContent();
  return expect
    .poll(shown, { timeout: REPORT_TIMEOUT_MS })
    .toContain(text)
    .then(
      () => true,
      () => false,
    );
}

/** The index page under a fresh slot, then what `act` starts on the IdP: the renew frame or the popup. */
async function idpSample(run: Run, reach: Reach, act: (page: Page) => Promise<boolean>) {
  const marker = await nextSlot(run.extension);
  const tab = await openTab(run);
  const since = await checkpoint();
  await tab.page.goto(`${APP}/`);
  await markerSeen(since, "index:first-paint");
  const message = await act(tab.page);
  const entries = await ledger(since);
  await finish(run, tab);
  const expected = reach === "with-idp" ? ("marked" as const) : ("unmarked" as const);
  return { marker, variant: reach, expect: expected, entries, message };
}

/** The silent-renew iframe on the IdP, which Route C reaches only when registered there. */
export async function frameSample(run: Run, reach: Reach): Promise<E7Sample> {
  const { entries, message, ...base } = await idpSample(run, reach, async (page) => {
    await page.locator("#renew").click();
    return logShows(page, "fixture-renew");
  });
  const paths = realmPaths(entries, "idp-renew:start", [IDP]);
  return { hypothesis: "cross-site-iframe", ...base, ...paths, openerMessage: message };
}

/** The login popup on the IdP, signed in through its form; the opener must still get its message. */
export async function popupSample(run: Run, reach: Reach): Promise<E7Sample> {
  const { entries, message, ...base } = await idpSample(run, reach, async (page) => {
    const opened = page.waitForEvent("popup");
    await page.locator("#popup-login").click();
    const popup = await opened;
    await popup.locator("input[name=username]").fill("alice");
    const closed = popup.waitForEvent("close", { timeout: REPORT_TIMEOUT_MS });
    await popup.locator("button[type=submit]").click();
    // A popup that never closes is the evidence; the opener's log says whether the message came.
    await closed.catch(() => undefined);
    if (!popup.isClosed()) await popup.close();
    return logShows(page, "fixture-login");
  });
  const paths = realmPaths(entries, "idp-login:start", [IDP]);
  return { hypothesis: "popup", ...base, ...paths, openerMessage: message };
}

/** Two tabs of one slot on the same shared worker, and the shared-worker targets Chrome ran. */
export async function identityPair(run: Run, variant: string): Promise<IdentitySample> {
  const marker = variant === "control-native" ? "none" : await nextSlot(run.extension);
  const first = await openTab(run);
  const second = await openTab(run);
  const url = `${APP}/workers.html?type=classic`;
  await Promise.all([reportOf(first.page, url), reportOf(second.page, url)]);
  const urls = await sharedWorkersLeft(run);
  await finish(run, first, second);
  return { variant, marker, instances: urls.length, urls };
}
