import type { Page } from "@playwright/test";
import type { LoadedExtension } from "./fixtures/extension.ts";
import {
  APP,
  CONTROL,
  checkpoint,
  closeAndSettle,
  evaluate,
  expect,
  inventoryOf,
  ledger,
  markerSeen,
  prepareFixture,
  reportOf,
  tabOf,
  test,
  writeSamples,
} from "../experiments/page-loads.ts";
import type { LedgerEntry, Run } from "../experiments/page-loads.ts";

// P1.7: the original session neither sees, clears, nor creates the namespaced sessions' stores.
// The fixture app never enumerates, clears, or names __rec: stores, so the isolator's probe runs
// that page code in the original session's page (recnrunOriginal, MAIN world).
const RUN = Date.now().toString(36);
const RESERVED = "__rec:x";
const STORE_APIS = 9;
// for-in also walks Storage.prototype, whose WebIDL members are enumerable.
const STORAGE_MEMBERS = ["length", "clear", "getItem", "key", "removeItem", "setItem"];

interface Listing {
  diagnostics: unknown;
  databases: string[];
  caches: string[];
  localStorage: {
    keys: string[];
    forIn: string[];
    byIndex: string[];
    length: number;
    json: string;
  };
}

/** The physical names the namespaced load leaves under its slot. */
interface Namespaced {
  slot: string;
  database: string;
  item: string;
}

let tabs = 0;

/** A new tab Route A knows by id. */
async function openTab(run: Run): Promise<{ page: Page; tabId: number }> {
  const page = await run.context.newPage();
  tabs += 1;
  const tabId = await tabOf(run.extension, page, `about:blank#recnrun-p17-${RUN}-${tabs}`);
  return { page, tabId };
}

function original<T>(extension: LoadedExtension, call: string, request: object): Promise<T> {
  return evaluate<T>(extension, `globalThis.recnrunOriginal.${call}(${JSON.stringify(request)})`);
}

function refusal(api: string, name: string): string {
  return `SecurityError: RECnRun refused ${api}("${name}"): names that start with "__rec:" are reserved`;
}

/** Every name a listing shows, from each enumeration a page can make. */
function namesOf({ databases, caches, localStorage }: Listing): string[] {
  const { keys, forIn, byIndex, json } = localStorage;
  const stored = Object.keys(JSON.parse(json) as object);
  const items = forIn.filter((name) => !STORAGE_MEMBERS.includes(name));
  return [...databases, ...caches, ...keys, ...items, ...byIndex, ...stored];
}

/** The `__rec` marker each request carried, which the bootstrap adds to fetch() in a namespaced session. */
function markersIn(entries: LedgerEntry[]): string[] {
  return entries.flatMap(({ path }) => new URL(path, APP).searchParams.getAll("__rec"));
}

/** A marked load of /storage.html, which stores under `__rec:<slot>:`, plus a seeded localStorage item. */
async function namespacedLoad(run: Run, ns: Namespaced): Promise<void> {
  const since = await checkpoint();
  const { page, tabId } = await openTab(run);
  expect(await reportOf(page, `${APP}/storage.html`)).not.toHaveProperty("error");
  await markerSeen(since, "storage:first-paint");
  expect(markersIn(await ledger(since))).toContain(ns.slot);
  const seeded = await original(run.extension, "seed", {
    tabId,
    key: ns.item,
    value: "namespaced",
  });
  expect(seeded).toBe("namespaced");
  await closeAndSettle(run, page);
}

/** An original-session load of /storage.html: its stores are unprefixed and its requests unmarked. */
async function originalLoad(run: Run): Promise<void> {
  const since = await checkpoint();
  const { page } = await openTab(run);
  expect(await reportOf(page, `${APP}/storage.html`)).not.toHaveProperty("error");
  await markerSeen(since, "storage:first-paint");
  expect(markersIn(await ledger(since))).toEqual([]);
  // Closing releases the IndexedDB connection storage.js leaves open, so the probe can delete it.
  await closeAndSettle(run, page);
}

/** Lists the stores and tries each reserved name; returns what the page saw. */
async function listAndRefuse(run: Run, tabId: number, ns: Namespaced) {
  const listed = await original<Listing>(run.extension, "probe", { tabId, step: "list" });
  expect(namesOf(listed).filter((name) => name.startsWith("__rec:"))).toEqual([]);
  expect(listed).toMatchObject({ databases: ["fixture-page"], caches: ["fixture-page"] });
  expect(listed.localStorage).toMatchObject({ keys: ["fixture:user"], length: 1 });
  expect(listed.diagnostics).toMatchObject({ original: true });
  const refused: Record<string, Record<string, string>> = {};
  for (const name of [RESERVED, ns.database, ns.item]) {
    const request = { tabId, step: "refuse", name };
    const outcomes = await original<Record<string, string>>(run.extension, "probe", request);
    refused[name] = outcomes;
    expect(Object.keys(outcomes)).toHaveLength(STORE_APIS);
    for (const [api, outcome] of Object.entries(outcomes)) {
      expect(outcome, api).toBe(refusal(api, name));
    }
  }
  return { listed, refused };
}

/** Clears like a page would; returns what it deleted and what the page lists afterwards. */
async function clearLikeAPage(run: Run, tabId: number) {
  const cleared = await original<object>(run.extension, "probe", { tabId, step: "clear" });
  expect(cleared).toEqual({ databases: ["fixture-page"], caches: ["fixture-page"] });
  const after = await original<Listing>(run.extension, "probe", { tabId, step: "list" });
  expect(namesOf(after)).toEqual([]);
  return { cleared, after };
}

test.describe("P1.7: the original session's filter", () => {
  test("hides, keeps, and refuses the reserved prefix in the original session", async ({
    extension,
    observer,
  }) => {
    await prepareFixture(extension);
    const run: Run = { extension, context: observer.page.context() };
    const install = JSON.stringify({ marker: `p17-${RUN}` });
    const slot = await evaluate<string>(extension, `globalThis.recnrunRouteC.install(${install})`);
    const ns = { slot, database: `__rec:${slot}:fixture-page`, item: `__rec:${slot}:fixture:user` };
    await namespacedLoad(run, ns);
    expect(await evaluate(extension, "globalThis.recnrunRouteC.setOriginal()")).toBe("original");
    await originalLoad(run);

    const { page, tabId } = await openTab(run);
    await page.goto(`${APP}/`);
    const before = await inventoryOf(run, page, "p17-before-clear");
    expect(before?.indexedDB).toEqual(expect.arrayContaining([ns.database, "fixture-page"]));
    expect(before?.cacheStorage).toEqual(expect.arrayContaining([ns.database, "fixture-page"]));
    expect(before?.localStorage).toEqual(expect.arrayContaining([ns.item, "fixture:user"]));
    const seen = await listAndRefuse(run, tabId, ns);
    const clear = await clearLikeAPage(run, tabId);
    const kept = await inventoryOf(run, page, "p17-after-clear");
    expect(kept?.indexedDB).toEqual([ns.database]);
    expect(kept?.cacheStorage).toEqual([ns.database]);
    expect(kept?.localStorage).toEqual([ns.item]);

    await evaluate(extension, "globalThis.recnrunRouteC.uninstall()");
    await observer.snapshotStorage([APP]);
    await observer.collectLedger(CONTROL);
    await writeSamples(observer.directory, [{ ns, before, ...seen, ...clear, kept }]);
    await page.close();
  });
});
