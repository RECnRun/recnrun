import type { Page } from "@playwright/test";
import { expect } from "../browser/fixtures/extension.ts";
import type { OriginInventory } from "../browser/observer/storage.ts";
import type { E3Entry, E3Sample } from "./e3-samples.ts";
import { fromOf } from "./e3-samples.ts";
import {
  API,
  APP,
  REPORT_TIMEOUT_MS,
  call,
  checkpoint,
  inventoryOf,
  ledger,
  pathOf,
  reportOf,
  sharedWorkersLeft,
  tabOf,
  targetsLeft,
} from "./page-loads.ts";
import type { LedgerEntry, Run } from "./page-loads.ts";

// How E3 (tests/experiments/E3-route-a-cold.spec.ts) loads pages, attaches workers, and stops them.

/** `RECNRUN_STRESS_CONDITION` of scripts/test-stress.mjs; `baseline` outside a stress run. */
export const CONDITION = process.env.RECNRUN_STRESS_CONDITION ?? "baseline";
export const BLANK = "about:blank#recnrun-e3";
// Base 36 has no 32-hex run, which the evidence redaction would hash.
const RUN = Date.now().toString(36);
const STOP_TIMEOUT_MS = 45_000;
const POLL_MS = 50;

/** How the load reaches its workers: armed with pauseBeforeScript, `watch`, or not at all. */
export type Attach = "pause" | "watch" | "none";

/** What `closeTarget` answered (apps/isolator/src/background/route-a/types.ts). */
export interface CloseReport {
  targetId: string;
  attach: string;
  close: string;
  detach: string;
  listedAfter: boolean;
}

export interface Stop {
  closes: CloseReport[];
  /** Whether Chrome stopped listing every service worker of the app origin within the bound. */
  stopped: boolean;
  stopMs: number;
}

export interface WatchReport {
  staleSkipped: number;
  polls: number;
  pollErrors: string[];
  entries: E3Entry[];
}

/** What one page load left: the ledger after its checkpoint, the attached workers, the stores. */
export interface Loaded {
  entries: LedgerEntry[];
  journal: E3Entry[];
  /** What `watch` or the journal said beyond its entries: polls, skipped and unattached targets. */
  seen?: unknown;
  inventory: OriginInventory | undefined;
  report: unknown;
  painted: boolean;
}

export interface LoadPlan {
  url: string;
  name: "sw" | "workers";
  marker: string;
  attach: Attach;
  /** Whether to clear the origin after the load; a warm run keeps it. */
  clear: boolean;
}

export function markerFor(name: string, iteration: number): string {
  return `e3-${name}-${iteration}-${RUN}`;
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it holds or `timeoutMs` passes, and says which. */
export async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() >= end) return false;
    await delay(POLL_MS);
  }
  return true;
}

export async function setMarker(run: Run, marker: string): Promise<void> {
  await call(run.extension, `setMarker(${JSON.stringify(marker)})`);
}

/** Starts attaching before the page loads; switch-late changes the marker after arming. */
async function begin(run: Run, tabId: number, { attach, marker }: LoadPlan): Promise<void> {
  if (attach === "none") return;
  if (attach === "watch") {
    await setMarker(run, marker);
    await call(run.extension, `watch(${JSON.stringify({ origin: APP, marker })})`);
    return;
  }
  if (CONDITION !== "switch-late") await setMarker(run, marker);
  await call(run.extension, `arm(${JSON.stringify({ tabId, pauseBeforeScript: true })})`);
  if (CONDITION === "switch-late") await setMarker(run, marker);
}

async function end(run: Run, tabId: number, attach: Attach) {
  if (attach === "none") return { journal: [] };
  if (attach === "watch") {
    const { entries, ...seen } = await call<WatchReport>(run.extension, "unwatch()");
    return { journal: entries, seen };
  }
  const journal = await call<{ entries: E3Entry[]; unattached: unknown[] }>(
    run.extension,
    `disarm({ tabId: ${tabId} })`,
  );
  return { journal: journal.entries, seen: { unattached: journal.unattached } };
}

/** Whether the page sent `<name>:first-paint`, after it showed its report, within the bound. */
export async function paintedSince(since: number, name: string): Promise<boolean> {
  const seen = async () => (await ledger(since)).some((e) => e.marker === `${name}:first-paint`);
  return until(seen, REPORT_TIMEOUT_MS);
}

export async function serviceWorkersGone(run: Run, timeoutMs = STOP_TIMEOUT_MS): Promise<boolean> {
  return until(async () => (await targetsLeft(run, "service_worker")).length === 0, timeoutMs);
}

/** Stops every service worker of the app origin through the isolator, then waits until it is gone. */
export async function stopServiceWorkers(run: Run): Promise<Stop> {
  const started = performance.now();
  const closes: CloseReport[] = [];
  for (const { id: targetId } of await targetsLeft(run, "service_worker")) {
    const request = JSON.stringify({ targetId });
    closes.push(await call<CloseReport>(run.extension, `closeTarget(${request})`));
  }
  const stopped = await serviceWorkersGone(run);
  return { closes, stopped, stopMs: round(performance.now() - started) };
}

/** Loads `plan.url` in a new tab, attaching as the plan says, and returns what the load left. */
export async function load(run: Run, plan: LoadPlan): Promise<Loaded> {
  // A navigation keeps the last page in the back/forward cache with its shared worker; a closed tab does not.
  const page = await run.context.newPage();
  if (CONDITION === "net-delay") await page.goto(`${API}/slow?ms=300`);
  const tabId = await tabOf(run.extension, page, `${BLANK}-${plan.marker}`);
  await begin(run, tabId, plan);
  const since = await checkpoint();
  const report = await reportOf(page, plan.url);
  const painted = await paintedSince(since, plan.name);
  const attached = await end(run, tabId, plan.attach);
  const inventory = await inventoryOf(run, page, plan.marker);
  const loaded: Loaded = { entries: await ledger(since), ...attached, inventory, report, painted };
  if (plan.clear) await call(run.extension, `clearOrigin({ tabId: ${tabId} })`);
  await page.close();
  await expect.poll(() => sharedWorkersLeft(run), { timeout: REPORT_TIMEOUT_MS }).toEqual([]);
  // cold: no worker of a cleared origin may still run when the next load starts.
  if (plan.clear && CONDITION === "cold") await stopServiceWorkers(run);
  return loaded;
}

/** Opens a page of the app origin, reads its stores, and clears the origin. */
export async function clearApp(run: Run, label: string): Promise<OriginInventory | undefined> {
  const page: Page = await run.context.newPage();
  const tabId = await tabOf(run.extension, page, `${APP}/offline.html`);
  const inventory = await inventoryOf(run, page, label);
  await call(run.extension, `clearOrigin({ tabId: ${tabId} })`);
  await page.close();
  await stopServiceWorkers(run);
  return inventory;
}

export function namesOf(inventory: OriginInventory | undefined): string[] {
  const names = [inventory?.indexedDB, inventory?.cacheStorage];
  return names.flatMap((list) => (Array.isArray(list) ? list : []));
}

// The harness's own control calls reach the API origin too; they are never a worker's effect.
const HARNESS_PATHS = ["/__network", "/__expire"];

/** A service worker's requests: the API origin's, minus another worker's top-level request. */
export function swEffect(script: string): (entry: LedgerEntry) => boolean {
  return (entry) =>
    entry.origin === API &&
    !HARNESS_PATHS.some((path) => entry.path.startsWith(path)) &&
    (fromOf(entry.path) ?? script) === script;
}

/** A dedicated worker's requests: the ones that name it in `from`. */
export function workerEffect(script: string): (entry: LedgerEntry) => boolean {
  return (entry) => fromOf(entry.path) === script;
}

type SampleBase = Omit<E3Sample, "effects" | "databases" | "caches" | "entry">;

export function sampleOf(
  loaded: Pick<Loaded, "entries" | "journal" | "inventory">,
  sample: SampleBase,
  isEffect: (entry: LedgerEntry) => boolean,
): E3Sample {
  const entry = loaded.journal.find((item) => pathOf(item.url) === sample.script);
  const missing = { error: "no inventory of the app origin" };
  return {
    ...sample,
    effects: loaded.entries.filter(isEffect).map((item) => item.path),
    databases: loaded.inventory?.indexedDB ?? missing,
    caches: loaded.inventory?.cacheStorage ?? missing,
    ...(entry ? { entry } : {}),
  };
}
