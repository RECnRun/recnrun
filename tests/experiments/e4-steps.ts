import type { Page } from "@playwright/test";
import type { RestartEntry, Trigger } from "./e4-samples.ts";
import {
  API,
  APP,
  call,
  checkpoint,
  control,
  expect,
  fromOf,
  inventoryOf,
  ledger,
  pathOf,
  REPORT_TIMEOUT_MS,
  reportOf,
  tabOf,
} from "./page-loads.ts";
import type { LedgerEntry, Run } from "./page-loads.ts";

// Steps of E4 (tests/experiments/E4-stop-restart.spec.ts): every chrome.* call runs in the isolator.
const STOP = "globalThis.recnrunStop";
const BLANK = "about:blank#recnrun-e4";
const SCRIPTS: Record<string, string> = {
  classic: "/sw-main.js?variant=classic",
  module: "/sw-main.js?variant=module",
};
/** How long a trigger gets to start the worker again; a worker that does not answers nothing. */
const RESTART_WAIT_MS = 8_000;
const NAVIGATION_MS = 8_000;
const SYNC_WAIT_MS = 5_000;
const POLL_MS = 100;

export const json = (value: unknown): string => JSON.stringify(value);
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The journal of one isolator call (apps/isolator/src/background/stop/types.ts). */
export interface StopJournal {
  mechanism: string;
  startedAt: number;
  endedAt: number;
  calls: { api: string; method: string; error?: string; result?: unknown }[];
  outcome: Record<string, unknown>;
}

/** The part of a Route A journal entry E4 reads (apps/isolator/src/background/route-a/types.ts). */
export interface RouteAEntry {
  type: string;
  url: string;
  marker?: string;
  waitingForDebugger: boolean;
  installed?: unknown;
  released: boolean;
  error?: string;
}

export interface Started {
  page: Page;
  tabId: number;
  targetId: string;
  script: string;
  report: unknown;
}

export interface Fired {
  trigger: Trigger;
  /** `Date.now()` when the trigger went out, on the clock the fixture's ledger uses. */
  at: number;
  since: number;
  /** The tab the trigger opened, for a navigation. */
  page?: Page;
  tabId?: number;
  /** The tab armed for the restart, if any. */
  armed?: number;
  result: unknown;
}

export async function stopCall<T = StopJournal>(run: Run, expression: string): Promise<T> {
  return call<T>(run.extension, expression, STOP);
}

export async function setMarker(run: Run, marker: string): Promise<void> {
  await call(run.extension, `setMarker(${json(marker)})`);
}

async function arm(run: Run, tabId: number, marker: string): Promise<void> {
  await setMarker(run, marker);
  await call(run.extension, `arm(${json({ tabId })})`);
}

/** Route A's journal entries for workers of the script it attached since the arm. */
export async function disarm(run: Run, tabId: number, script: string): Promise<RouteAEntry[]> {
  const journal = await call<{ entries: RouteAEntry[] }>(
    run.extension,
    `disarm(${json({ tabId })})`,
  );
  return journal.entries.filter(
    (item) => item.type === "service_worker" && pathOf(item.url) === script,
  );
}

export function restartOf(entry: RouteAEntry | undefined): RestartEntry | undefined {
  if (!entry) return undefined;
  const { waitingForDebugger, installed, released, error } = entry;
  return {
    observedBy: "auto-attach",
    waitingForDebugger,
    installed,
    released,
    ...(error === undefined ? {} : { error }),
  };
}

/** Chrome's own list of targets, so the isolator's view is not the only one. */
export async function targetInfo(run: Run, targetId: string) {
  const { targetInfos } = await run.extension.chrome.cdp.send("Target.getTargets");
  const found = targetInfos.find((target) => target.targetId === targetId);
  return found ? { type: found.type, url: pathOf(found.url), attached: found.attached } : null;
}

async function serviceWorkers(run: Run): Promise<{ targetId: string; url: string }[]> {
  const { targetInfos } = await run.extension.chrome.cdp.send("Target.getTargets");
  return targetInfos
    .filter((target) => target.type === "service_worker" && target.url.startsWith(APP))
    .map(({ targetId, url }) => ({ targetId, url: pathOf(url) }));
}

/** Milliseconds from `since` to Chrome no longer listing the target, or `null` at the bound. */
export async function unlisted(run: Run, targetId: string, since: number, boundMs: number) {
  while (Date.now() - since < boundMs) {
    if ((await targetInfo(run, targetId)) === null) return Date.now() - since;
    await sleep(POLL_MS);
  }
  return null;
}

async function markersSince(since: number, names: string[], timeoutMs: number): Promise<boolean> {
  const seen = async () => {
    const markers = new Set((await ledger(since)).map((entry) => entry.marker));
    return names.every((name) => markers.has(name));
  };
  return expect
    .poll(seen, { timeout: timeoutMs })
    .toBe(true)
    .then(
      () => true,
      () => false,
    );
}

/** A new tab, armed with `marker`, that registers the variant and waits until it painted. */
export async function startWorker(run: Run, variant: string, marker: string): Promise<Started> {
  const script = SCRIPTS[variant] ?? "";
  const page = await run.context.newPage();
  const tabId = await tabOf(run.extension, page, `${BLANK}-${marker}`);
  await arm(run, tabId, marker);
  const since = await checkpoint();
  const report = await reportOf(page, `${APP}/sw.html?sw=${variant}`);
  // sw.html registers Background Sync too; its event must not land after the stop.
  await markersSince(since, ["sw:first-paint", "sw:sync:fixture-sync"], REPORT_TIMEOUT_MS);
  const worker = (await serviceWorkers(run)).find((item) => item.url === script);
  if (!worker) throw new Error(`no ${script} target after ${marker}`);
  return { page, tabId, targetId: worker.targetId, script, report };
}

function isWorkerRequest(entry: LedgerEntry, script: string): boolean {
  if (entry.origin === API && entry.path.startsWith("/me?")) return fromOf(entry.path) === script;
  return /^sw:(sync|push)/.test(entry.marker ?? "");
}

/** Ledger paths of the worker's own requests after `since`, up to `until` when given. */
export async function workerRequests(since: number, script: string, until = Infinity) {
  return (await ledger(since))
    .filter((entry) => entry.seq <= until && isWorkerRequest(entry, script))
    .map((entry) => entry.path);
}

/** The first fresh start of the script after the trigger, waited for up to the bound. */
export async function restartAfter(fired: Fired, script: string): Promise<LedgerEntry | undefined> {
  const deadline = fired.at + RESTART_WAIT_MS;
  while (Date.now() < deadline) {
    const found = (await ledger(fired.since)).find(
      (entry) => entry.origin === API && fromOf(entry.path) === script,
    );
    if (found) return found;
    await sleep(POLL_MS);
  }
  return undefined;
}

async function navigate(run: Run, armWith: string | undefined, label: string): Promise<Fired> {
  const page = await run.context.newPage();
  const tabId = await tabOf(run.extension, page, `${BLANK}-${label}`);
  if (armWith) await arm(run, tabId, armWith);
  const since = await checkpoint();
  const at = Date.now();
  const result = await page.goto(`${APP}/offline.html`, { timeout: NAVIGATION_MS }).then(
    (response) => ({ finished: true, status: response?.status() ?? null, ms: Date.now() - at }),
    (error: unknown) => ({ finished: false, error: String(error).split("\n")[0] }),
  );
  return {
    trigger: "navigation",
    at,
    since,
    page,
    tabId,
    ...(armWith ? { armed: tabId } : {}),
    result,
  };
}

/** Fires one restart trigger; `armWith` arms the tab that will see the restart with that marker. */
export async function fire(
  run: Run,
  started: Started,
  trigger: Trigger,
  options: { armWith?: string; label: string },
): Promise<Fired> {
  if (trigger === "navigation") return navigate(run, options.armWith, options.label);
  const { tabId } = started;
  if (options.armWith) await arm(run, tabId, options.armWith);
  const armed = options.armWith ? { armed: tabId } : {};
  const since = await checkpoint();
  if (trigger === "post-message") {
    const at = Date.now();
    const journal = await stopCall(run, `client(${json({ tabId, action: "post-message" })})`);
    return { trigger, at, since, ...armed, result: journal.outcome };
  }
  const tag = options.label.slice(0, 64);
  // The fixture's cut leaves Chrome online, so this records whether the cut holds the event back.
  await control("/__network?mode=offline");
  const at = Date.now();
  const journal = await stopCall(run, `client(${json({ tabId, action: "sync", tag })})`);
  const fired = await markersSince(since, [`sw:sync:${tag}`], SYNC_WAIT_MS);
  await control("/__network?mode=online");
  return { trigger, at, since, ...armed, result: { ...journal.outcome, firedWhileCut: fired } };
}

/** What the stop left: the registration and its sync tags, and whether the precache survived. */
export async function sideEffects(run: Run, page: Page, tabId: number, label: string) {
  const status = await stopCall(run, `client(${json({ tabId, action: "status" })})`);
  const value = status.outcome.value as { registration?: unknown } | undefined;
  const caches = (await inventoryOf(run, page, label))?.cacheStorage;
  return {
    status: status.outcome,
    registrationKept: value ? value.registration !== null : null,
    precacheKept: Array.isArray(caches)
      ? caches.some((name) => name.endsWith("fixture-shell-v1"))
      : null,
    caches: caches ?? null,
  };
}

/** Ledger paths of service-worker scripts fetched after `since`: update checks reaching the server. */
export async function scriptFetches(since: number): Promise<string[]> {
  return (await ledger(since))
    .filter((entry) => entry.origin === APP && entry.path.startsWith("/sw-"))
    .map((entry) => entry.path);
}

/**
 * Leaves no registration, worker, or tab of the app behind: clears the origin through a tab on
 * it, stops every worker still listed, and closes the pages.
 */
export async function cleanup(run: Run, tabs: { page: Page; tabId: number }[]): Promise<void> {
  await control("/__network?mode=online");
  await stopCall(run, "unblock()");
  const open = tabs.filter(({ page }) => !page.isClosed());
  let onOrigin = open.find(({ page }) => page.url().startsWith(APP));
  if (!onOrigin) {
    const page = await run.context.newPage();
    onOrigin = { page, tabId: await tabOf(run.extension, page, `${BLANK}-cleanup`) };
    open.push(onOrigin);
    await page.goto(`${APP}/offline.html`);
  }
  await call(run.extension, `clearOrigin(${json({ tabId: onOrigin.tabId })})`);
  for (const { page } of open) await page.close();
  for (const worker of await serviceWorkers(run)) {
    await stopCall(run, `closeTarget(${json({ targetId: worker.targetId })})`).catch(() => null);
  }
  await expect.poll(async () => (await serviceWorkers(run)).length, { timeout: 15_000 }).toBe(0);
}
