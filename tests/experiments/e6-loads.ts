import type { Page } from "@playwright/test";
import { expect } from "../browser/fixtures/extension.ts";
import { arm, CLASSIC, register, reset, snapshot, stopWorkers, waitUntil } from "./e5-loads.ts";
import type { ArmOptions, Armed } from "./e5-loads.ts";
import { markerIn } from "./e5-samples.ts";
import type { Names, RouteBJournal } from "./e5-samples.ts";
import type { SwitchSample } from "./e6-samples.ts";
import { API, APP, checkpoint, inventoryOf, isolator, ledger } from "./page-loads.ts";
import { REPORT_TIMEOUT_MS, reportOf, sharedWorkersLeft, targetsLeft } from "./page-loads.ts";
import type { Run } from "./page-loads.ts";

// Page loads of E6 (tests/experiments/E6-route-b-selection.spec.ts): the isolator's session rules
// and Route B select the slot; Route A's clearOrigin resets the origin between samples.
export const CONDITION = process.env.RECNRUN_STRESS_CONDITION ?? "baseline";
const WORKER_PATTERN = "*worker.js?type=*";
const WORKERS = `${APP}/workers.html?type=classic`;
const SCOPE_PAGE = `${APP}/storage.html`;
const START_WAIT_MS = 5_000;
const SWITCH_POLL_MS = 10;
const SETTLE_WAIT_MS = 10_000;
// Chrome held restarts behind a soft update's waiting version for 300 s in exploration runs.
const RESTART_TIMEOUT_MS = 20_000;
// What sw-main.js precaches during install; the last of these requests comes just before activation.
const SHELL = new Set(["/offline.html", "/index.html", "/index.js", "/page.js"]);
const SW_STORE = "fixture-sw";

export type Timing = SwitchSample["timing"];

export interface Plan {
  selection: string;
  before: number;
  after: number;
  timing: Timing;
  /** Runs after the switch and before the next start, as a suspension of the background does. */
  between?: () => Promise<void>;
}

export interface Selected {
  slot: number;
  updateMs: number;
}

interface Switched {
  at: number;
  updateMs: number;
}

/** The marker of slot `slot` (apps/isolator/public/ns/slot-<k>.js). */
export const slotName = (slot: number) => `slot-${slot}`;

export const namesOf = (inventory: { indexedDB: Names } | undefined): Names =>
  inventory?.indexedDB ?? { error: "no inventory of the app origin" };

/** Points the isolator's session rules for the app origin at slot `slot`. */
export async function select(run: Run, slot: number): Promise<Selected> {
  const request = JSON.stringify({ slot, origins: [APP] });
  return isolator<Selected>(run.extension, `recnrunSelection.select(${request})`);
}

async function switchNow(run: Run, slot: number): Promise<Switched> {
  const { updateMs } = await select(run, slot);
  return { at: Date.now(), updateMs };
}

/** Switches to `slot` as soon as the ledger shows `path` fetched, so before the worker activates. */
async function switchOnFetch(run: Run, since: number, path: string, slot: number) {
  const deadline = Date.now() + REPORT_TIMEOUT_MS;
  while (Date.now() < deadline && !(await ledger(since)).some((e) => e.path.startsWith(path))) {
    await new Promise((resolve) => setTimeout(resolve, SWITCH_POLL_MS));
  }
  return switchNow(run, slot);
}

/** Whether the switch resolved before the last request the first worker's install made. */
async function beforeActivated(since: number, switched: Switched): Promise<boolean | undefined> {
  const entries = await ledger(since);
  const script = entries.find((entry) => entry.path === CLASSIC);
  if (!script) return undefined;
  const install = entries.filter(
    (e) => e.seq > script.seq && SHELL.has(e.path.split("?")[0] ?? ""),
  );
  const last = install.at(-1);
  return last === undefined ? undefined : switched.at < last.ts;
}

export const disarm = (run: Run, armed: Armed) =>
  isolator<RouteBJournal>(run.extension, `recnrunRouteB.disarm(${armed.tab})`);

export async function newTab(run: Run): Promise<Page> {
  const page = await run.context.newPage();
  if (CONDITION === "net-delay") await page.goto(`${API}/slow?ms=300`);
  return page;
}

/** Ends a sample: cold runs clear the origin; warm runs keep the stores and drop only the registration. */
async function finish(run: Run, armed: Armed): Promise<void> {
  if (CONDITION !== "warm") return reset(run, armed);
  await isolator(run.extension, `recnrunStop.unregister(${armed.tab})`);
  await armed.page.close();
  await stopWorkers(run);
}

/** Markers on requests after `since`, in the ledger and on the workers' sessions; only the bootstrap adds them. */
export async function runningAfter(since: number, journal?: RouteBJournal): Promise<string[]> {
  const paths = (await ledger(since)).map((entry) => entry.path);
  // Route B logs a worker's blocked or dropped requests too, which never reach the ledger.
  const urls = (journal?.network ?? []).flatMap((entry) => (entry.url ? [entry.url] : []));
  const markers = [...paths, ...urls].map((path) => markerIn(path));
  return [...new Set(markers.filter((marker) => marker !== null))];
}

/** Polls the page's view of the registration until no version is installing or waiting. */
export async function settle(run: Run, armed: Armed): Promise<boolean> {
  const request = JSON.stringify({ ...JSON.parse(armed.tab), action: "status" });
  type Status = { outcome: { value?: { registration?: Record<string, unknown> | null } } };
  const settled = async () => {
    const journal = await isolator<Status>(run.extension, `recnrunStop.client(${request})`);
    const registration = journal.outcome.value?.registration;
    if (registration === null) return true;
    return registration?.installing === null && registration.waiting === null;
  };
  return waitUntil(settled, SETTLE_WAIT_MS);
}

/** How many times Chrome fetched the worker's script after `since` and up to `until`: more than once is an update. */
export async function scriptFetches(
  since: number,
  until = Number.MAX_SAFE_INTEGER,
): Promise<number> {
  const entries = await ledger(since);
  return entries.filter((entry) => entry.path === CLASSIC && entry.seq <= until).length;
}

/** Stops the service workers, then opens a page under the scope in a new tab armed with `marker`. */
export async function restartService(run: Run, marker: string, options: ArmOptions) {
  const { workersGone } = await stopWorkers(run);
  const armed = await arm(run, await newTab(run), marker, { ...options, network: true });
  const since = await checkpoint();
  const startedAt = Date.now();
  // storage.js is not precached, so the restarted worker fetches it with its marker on the URL.
  const navigation = armed.page.goto(SCOPE_PAGE, { timeout: RESTART_TIMEOUT_MS });
  const committed = await navigation.then(
    () => true,
    () => false,
  );
  const restartMs = Date.now() - startedAt;
  const listed = async () => (await targetsLeft(run, "service_worker")).length > 0;
  const started = workersGone && (await waitUntil(listed, START_WAIT_MS));
  const journal = await disarm(run, armed);
  const second = namesOf(await inventoryOf(run, armed.page, marker));
  const running = await runningAfter(since, journal);
  return { armed, since, started, stalled: !committed, restartMs, journal, second, running };
}

/** What the page reported for its worker when the first start failed, for example a refused registration. */
export function errorOf(report: unknown, key: string): string | undefined {
  if (typeof report !== "object" || report === null) return undefined;
  const value: unknown = Reflect.get(report, key);
  // The fixture's attempt() reports a thrown error as "error: <name>: <message>".
  if (typeof value === "string") return value.startsWith("error: ") ? value : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const error: unknown = Reflect.get(value, "error");
  return typeof error === "string" ? error : undefined;
}

/** A service worker installed under slot `before`, the slot switched, and the worker restarted. */
export async function switchService(run: Run, plan: Plan): Promise<SwitchSample> {
  await select(run, plan.before);
  const options: ArmOptions = { selection: plan.selection };
  const since = await checkpoint();
  const early =
    plan.timing === "early" ? switchOnFetch(run, since, CLASSIC, plan.after) : undefined;
  const registered = await register(run, "classic", slotName(plan.before), options);
  const switched = early ? await early : await switchNow(run, plan.after);
  const activated = early ? await beforeActivated(since, switched) : undefined;
  await plan.between?.();
  const first = await snapshot(run, registered, slotName(plan.before));
  // A soft update that Chrome started meanwhile must end before the restart, which it would hold.
  const settled = await settle(run, registered.armed);
  await registered.armed.page.close();
  const restarted = await restartService(run, slotName(plan.after), options);
  const fetches = await scriptFetches(since, restarted.since);
  await finish(run, restarted.armed);
  const error = errorOf(first.report, "worker");
  return {
    realm: "service",
    selection: plan.selection,
    timing: plan.timing,
    before: slotName(plan.before),
    after: slotName(plan.after),
    store: SW_STORE,
    first: namesOf(first.inventory),
    second: restarted.second,
    started: restarted.started,
    running: restarted.running,
    ...(error === undefined ? {} : { error }),
    switchMs: switched.updateMs,
    ...(activated === undefined ? {} : { beforeActivated: activated }),
    settled,
    scriptFetches: fetches,
    stalled: restarted.stalled,
    restartMs: restarted.restartMs,
    journal: restarted.journal,
  };
}

interface WorkersLoad {
  armed: Armed;
  report: unknown;
  journal: RouteBJournal;
  names: Names;
}

/** Loads the workers page in a new tab armed with the synchronous-XHR selection. */
async function loadWorkers(run: Run, marker: string): Promise<WorkersLoad> {
  const options: ArmOptions = { urlPattern: WORKER_PATTERN, selection: "sync-xhr" };
  const armed = await arm(run, await newTab(run), marker, options);
  const since = await checkpoint();
  const report = await reportOf(armed.page, WORKERS);
  const painted = async () => (await ledger(since)).some((e) => e.marker === "workers:first-paint");
  await expect.poll(painted, { timeout: REPORT_TIMEOUT_MS }).toBe(true);
  const journal = await disarm(run, armed);
  const names = namesOf(await inventoryOf(run, armed.page, marker));
  return { armed, report, journal, names };
}

async function closeWorkers(run: Run, load: WorkersLoad, clear: boolean): Promise<void> {
  if (clear) await isolator(run.extension, `recnrunRouteA.clearOrigin(${load.armed.tab})`);
  // A closed tab, unlike a navigation, does not keep its shared worker in the back/forward cache.
  await load.armed.page.close();
  await expect.poll(() => sharedWorkersLeft(run), { timeout: REPORT_TIMEOUT_MS }).toEqual([]);
}

const STARTED_ERRORS = /failed to start|no report/;

/** A dedicated and a shared worker loaded under slot `before`, the slot switched, and both loaded again. */
export async function switchWorkers(run: Run, plan: Plan): Promise<SwitchSample[]> {
  await select(run, plan.before);
  const since = await checkpoint();
  const early =
    plan.timing === "early" ? switchOnFetch(run, since, "/worker.js", plan.after) : undefined;
  const first = await loadWorkers(run, slotName(plan.before));
  await closeWorkers(run, first, false);
  const switched = early ? await early : await switchNow(run, plan.after);
  await plan.between?.();
  const second = await loadWorkers(run, slotName(plan.after));
  await closeWorkers(run, second, CONDITION !== "warm");
  return (["dedicated", "shared"] as const).map((realm) => {
    const failed = errorOf(second.report, realm) ?? "";
    const error = errorOf(first.report, realm);
    return {
      realm,
      selection: plan.selection,
      timing: plan.timing,
      before: slotName(plan.before),
      after: slotName(plan.after),
      store: `fixture-${realm}`,
      first: first.names,
      second: second.names,
      started: !STARTED_ERRORS.test(failed),
      ...(error === undefined ? {} : { error }),
      switchMs: switched.updateMs,
      journal: second.journal,
    };
  });
}
