import type { Page } from "@playwright/test";
import { expect } from "../browser/fixtures/extension.ts";
import type { OriginInventory } from "../browser/observer/storage.ts";
import { APP, checkpoint, control, fromOf, inventoryOf, isolator, ledger } from "./page-loads.ts";
import type { LedgerEntry, Run } from "./page-loads.ts";
import { REPORT_TIMEOUT_MS, reportOf, tabOf, targetsLeft } from "./page-loads.ts";
import type { UpdateOutcome } from "./e5-paths.ts";
import type { RouteBJournal } from "./e5-samples.ts";

// Page loads of E5 (tests/experiments/E5-route-b-fetch.spec.ts); every Fetch.*, Target.*, and
// Runtime.* command runs in the isolator's Route B, and Route A's clearOrigin resets the origin.
export const PATTERN = "*/sw-*.js*";
export const CLASSIC = "/sw-main.js?variant=classic";
const BLANK = "about:blank#recnrun-e5";
const POLL_MS = 100;
// A version that installs makes its first request within this time of update() resolving.
const EFFECT_WAIT_MS = 3_000;

export interface ArmOptions {
  urlPattern?: string;
  tabFetch?: boolean;
  workerFetch?: boolean;
  imports?: "continue" | "transform";
  network?: boolean;
}

interface Tab {
  page: Page;
  tab: string;
}

interface Armed extends Tab {
  fetchEnable: string;
}

/** What one armed registration left: the ledger after its checkpoint, the journal, and the stores. */
export interface Loaded {
  entries: LedgerEntry[];
  journal: RouteBJournal;
  inventory: OriginInventory | undefined;
  report: unknown;
  fetchEnable: string;
}

export interface Updated {
  first: Loaded;
  outcome: UpdateOutcome;
  /** Ledger entries after the update's checkpoint, and the journal of the update alone. */
  entries: LedgerEntry[];
  journal: RouteBJournal;
}

export interface Restarted {
  first: Loaded;
  stopped: unknown[];
  /** Whether Chrome listed no service worker on the app origin once the workers were closed. */
  workersGone: boolean;
  /** Ledger entries from the network cut to its restore. */
  entries: LedgerEntry[];
  /** The restart tab's journal; absent when the restart tab was not armed. */
  journal?: RouteBJournal;
  /** The document title the offline navigation showed, or Playwright's error for it. */
  shown: string;
  /** The stores read during the cut, after the restart. */
  inventory: OriginInventory | undefined;
}

const routeB = (call: string) => `recnrunRouteB.${call}`;

async function tabFor(run: Run, page: Page, marker: string): Promise<Tab> {
  const tabId = await tabOf(run.extension, page, `${BLANK}-${marker}-${Date.now()}`);
  return { page, tab: JSON.stringify({ tabId }) };
}

async function arm(run: Run, page: Page, marker: string, options: ArmOptions): Promise<Armed> {
  const tab = await tabFor(run, page, marker);
  const request = JSON.stringify({
    ...JSON.parse(tab.tab),
    marker,
    urlPattern: PATTERN,
    ...options,
  });
  const armed = await isolator<{ fetchEnable: string }>(run.extension, routeB(`arm(${request})`));
  return { ...tab, fetchEnable: armed.fetchEnable };
}

async function rearm(run: Run, armed: Armed, marker: string): Promise<RouteBJournal> {
  const journal = await isolator<RouteBJournal>(run.extension, routeB(`disarm(${armed.tab})`));
  const request = JSON.stringify({ ...JSON.parse(armed.tab), marker, urlPattern: PATTERN });
  await isolator(run.extension, routeB(`arm(${request})`));
  return journal;
}

/** Polls `done` until it holds or `ms` pass; false when it never held. */
async function waitUntil(done: () => Promise<boolean>, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += POLL_MS) {
    if (await done()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return done();
}

async function register(run: Run, variant: string, marker: string, options: ArmOptions = {}) {
  const page = await run.context.newPage();
  const armed = await arm(run, page, marker, options);
  const since = await checkpoint();
  const report = await reportOf(page, `${APP}/sw.html?sw=${variant}`);
  // The page sends first-paint after it shows its report, whether the registration worked or not.
  const painted = async () => (await ledger(since)).some((e) => e.marker === "sw:first-paint");
  await expect.poll(painted, { timeout: REPORT_TIMEOUT_MS }).toBe(true);
  return { armed, since, report };
}

interface Registered {
  armed: Armed;
  since: number;
  report: unknown;
}

async function snapshot(run: Run, { armed, since, report }: Registered, marker: string) {
  const journal = await isolator<RouteBJournal>(run.extension, routeB(`disarm(${armed.tab})`));
  const inventory = await inventoryOf(run, armed.page, marker);
  const entries = await ledger(since);
  return { entries, journal, inventory, report, fetchEnable: armed.fetchEnable };
}

async function stopWorkers(run: Run): Promise<{ stopped: unknown[]; workersGone: boolean }> {
  const stopped: unknown[] = [];
  for (const { id } of await targetsLeft(run, "service_worker")) {
    const request = JSON.stringify({ targetId: id });
    stopped.push(await isolator(run.extension, routeB(`stopWorker(${request})`)).catch(String));
  }
  const gone = async () => (await targetsLeft(run, "service_worker")).length === 0;
  return { stopped, workersGone: await waitUntil(gone, REPORT_TIMEOUT_MS) };
}

/** Clears the origin through Route A once Route B let the tab go, closes it, and stops workers. */
async function reset(run: Run, tab: Tab): Promise<void> {
  await isolator(run.extension, `recnrunRouteA.clearOrigin(${tab.tab})`);
  await tab.page.close();
  // An unregistered worker keeps running after its last client closes; the next load starts clean.
  expect((await stopWorkers(run)).workersGone, "service workers left on the app origin").toBe(true);
}

/** Registers `variant` from a new tab armed with `marker` and returns what the load left. */
export async function loadFirst(run: Run, variant: string, marker: string, options?: ArmOptions) {
  const registered = await register(run, variant, marker, options);
  const loaded: Loaded = await snapshot(run, registered, marker);
  await reset(run, registered.armed);
  return loaded;
}

/** Registers the classic variant, then calls registration.update() armed with `next`. */
export async function loadUpdate(run: Run, marker: string, next: string): Promise<Updated> {
  const registered = await register(run, "classic", marker);
  const { armed, since, report } = registered;
  const journal = await rearm(run, armed, next);
  const first = { entries: await ledger(since), journal, inventory: undefined, report };
  const updateSince = await checkpoint();
  const outcome = await isolator<UpdateOutcome>(run.extension, routeB(`update(${armed.tab})`));
  const effect = async () => (await ledger(updateSince)).some((e) => fromOf(e.path) === CLASSIC);
  await waitUntil(effect, EFFECT_WAIT_MS);
  const after = await snapshot(run, { ...registered, since: updateSince }, next);
  await reset(run, armed);
  return { first: { ...first, fetchEnable: armed.fetchEnable }, outcome, ...after };
}

export interface OfflineOptions {
  first?: ArmOptions;
  /** How the restart tab is armed; `false` leaves it unarmed. */
  restart?: ArmOptions | false;
}

interface Cut {
  shown: string;
  journal?: RouteBJournal;
  inventory: OriginInventory | undefined;
}

/** Navigates under the scope with the network cut and reads what the restart left before restoring it. */
async function restartOffline(run: Run, tab: Tab, armed: boolean, since: number): Promise<Cut> {
  await control("/__network?mode=offline");
  try {
    const shown = await tab.page.goto(`${APP}/index.html`).then(
      () => tab.page.title(),
      (error: Error) => error.message,
    );
    // The restarted worker marks what it fetches, so the first marked request shows it ran.
    const effect = async () => (await ledger(since)).some((e) => e.path.includes("__rec="));
    await waitUntil(effect, EFFECT_WAIT_MS);
    const journal = armed
      ? await isolator<RouteBJournal>(run.extension, routeB(`disarm(${tab.tab})`))
      : undefined;
    // Online, a soft update could install the unwrapped original before the stores are read.
    const inventory = await inventoryOf(run, tab.page, "offline-restart");
    return journal === undefined ? { shown, inventory } : { shown, inventory, journal };
  } finally {
    await control("/__network?mode=online");
  }
}

/** Restarts the worker of a first load from its stored script with the fixture's network cut. */
export async function loadOffline(run: Run, marker: string, next: string, options: OfflineOptions) {
  const registered = await register(run, "classic", marker, options.first);
  const first = await snapshot(run, registered, marker);
  await registered.armed.page.close();
  const { stopped, workersGone } = await stopWorkers(run);
  const page = await run.context.newPage();
  const restart = options.restart ?? {};
  const tab =
    restart === false ? await tabFor(run, page, next) : await arm(run, page, next, restart);
  const since = await checkpoint();
  const cut = await restartOffline(run, tab, restart !== false, since);
  const entries = await ledger(since);
  // Route A clears only a tab on the app origin, which a failed navigation would have left.
  await page.goto(`${APP}/offline.html`);
  await reset(run, tab);
  const restarted: Restarted = { first, stopped, workersGone, entries, ...cut };
  return restarted;
}
