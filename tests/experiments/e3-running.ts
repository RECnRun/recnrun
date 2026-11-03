import type { E3Entry, Mode } from "./e3-samples.ts";
import {
  BLANK,
  clearApp,
  delay,
  load,
  markerFor,
  namesOf,
  paintedSince,
  sampleOf,
  serviceWorkersGone,
  setMarker,
  stopServiceWorkers,
  swEffect,
  until,
} from "./e3-loads.ts";
import type { Loaded, Stop, WatchReport } from "./e3-loads.ts";
import {
  APP,
  SERVICE_WORKERS,
  call,
  checkpoint,
  control,
  inventoryOf,
  ledger,
  pathOf,
  reportOf,
  tabOf,
  targetsLeft,
} from "./page-loads.ts";
import type { Run } from "./page-loads.ts";
import { sized } from "./samples.ts";

// The E3 hypotheses about a worker Route A meets late: one already running, one woken without a tab.
export const RUNNING_SAMPLES = sized(10, 2);
export const WAKE_SAMPLES = sized(5);
export const WAKE_TIMEOUT_MS = 10_000;
const CUT_MS = 1_000;
const LISTED_TIMEOUT_MS = 5_000;
const GRACE_MS = 2_000;
const WAKE_SCRIPT = "/sw-main.js?variant=classic";
const VARIANTS = Object.entries(SERVICE_WORKERS);

interface Journal {
  entries: E3Entry[];
  unattached: unknown[];
}

/** Arms the tab of a page whose worker already runs: auto-attach reports the worker running. */
async function armRunning(run: Run, tabId: number, script: string) {
  await call(run.extension, `arm(${JSON.stringify({ tabId, pauseBeforeScript: true })})`);
  const listed = async () => {
    const { entries } = await call<Journal>(run.extension, "journal()");
    return entries.some((entry) => pathOf(entry.url) === script);
  };
  await until(listed, LISTED_TIMEOUT_MS);
  const journal = await call<Journal>(run.extension, `disarm({ tabId: ${tabId} })`);
  return { journal: journal.entries, seen: { unattached: journal.unattached } };
}

/**
 * `watch` leaves a worker listed before it alone by design, so this attaches the worker by id;
 * `stale` holds the targets listed before the page loaded, which may share the script's path.
 */
async function attachRunning(run: Run, marker: string, script: string, stale: Set<string>) {
  const request = JSON.stringify({ origin: APP, marker });
  const { staleSkipped } = await call<{ staleSkipped: number }>(run.extension, `watch(${request})`);
  const { entries: watched, ...watch } = await call<WatchReport>(run.extension, "unwatch()");
  // A blank tab holds the direct session, so disarming it detaches the worker again.
  const page = await run.context.newPage();
  const tabId = await tabOf(run.extension, page, `${BLANK}-direct-${marker}`);
  await call(run.extension, `arm({ tabId: ${tabId} })`);
  const target = (await targetsLeft(run, "service_worker")).find(
    ({ id: targetId, url: path }) => path === script && !stale.has(targetId),
  );
  const attachTarget = target
    ? await call(run.extension, `attachTarget(${JSON.stringify({ targetId: target.id })})`).then(
        () => "ok",
        (error: unknown) => String(error),
      )
    : "no service worker target listed";
  const journal = await call<Journal>(run.extension, `disarm({ tabId: ${tabId} })`);
  await page.close();
  const seen = { staleSkipped, watch, watchedEntries: watched.length, attachTarget };
  return { journal: journal.entries, seen };
}

/** Registers a worker unattached and, while its page keeps it running, arms or attaches it. */
async function runningSample(run: Run, iteration: number) {
  const mode: Mode = iteration % 2 === 0 ? "pause" : "direct";
  const [variant, script] = VARIANTS[Math.floor(iteration / 2) % VARIANTS.length] ?? [];
  if (variant === undefined || script === undefined) throw new Error("no service-worker variant");
  const marker = markerFor(`running-${mode}-${variant}`, iteration);
  const page = await run.context.newPage();
  const tabId = await tabOf(run.extension, page, `${BLANK}-${marker}`);
  const stale = new Set((await targetsLeft(run, "service_worker")).map((t) => t.id));
  const since = await checkpoint();
  const report = await reportOf(page, `${APP}/sw.html?sw=${variant}`);
  const painted = await paintedSince(since, "sw");
  await setMarker(run, marker);
  const attached =
    mode === "pause"
      ? await armRunning(run, tabId, script)
      : await attachRunning(run, marker, script, stale);
  const inventory = await inventoryOf(run, page, marker);
  const loaded: Loaded = { entries: await ledger(since), ...attached, inventory, report, painted };
  await call(run.extension, `clearOrigin({ tabId: ${tabId} })`);
  await page.close();
  // Whether the worker stopped by itself once its origin was cleared and its tab closed.
  const gone = await serviceWorkersGone(run, GRACE_MS);
  const cleanup = { stale: stale.size, goneWithinGrace: gone, stop: await stopServiceWorkers(run) };
  const variantName = mode === "pause" ? "armed" : "direct";
  const base = { hypothesis: "pre-existing-running", variant: variantName, mode, marker, script };
  const sample = sampleOf(loaded, { ...base, store: "fixture-sw" }, swEffect(script));
  return { loaded, sample, cleanup };
}

export async function runningSamples(run: Run) {
  const results: Awaited<ReturnType<typeof runningSample>>[] = [];
  for (let iteration = 0; iteration < RUNNING_SAMPLES; iteration += 1) {
    results.push(await runningSample(run, iteration));
  }
  return results;
}

/** What one wake attempt saw, whether or not the worker woke. */
export interface Wake {
  /** Whether the page's `fixture-sync` fired while the registering page was still open. */
  syncAtRegistration: boolean;
  stop: Stop;
  woke: boolean;
}

/**
 * Registers the classic worker, closes its tab, stops it, watches the origin, then cuts and restores
 * the fixture's network: a pending Background Sync would wake the worker without any tab.
 */
async function wakeSample(run: Run, iteration: number) {
  const url = `${APP}/sw.html?sw=classic`;
  const first = markerFor("wake-register", iteration);
  const registered = await load(run, {
    url,
    name: "sw",
    marker: first,
    attach: "none",
    clear: false,
  });
  const syncAtRegistration = registered.entries.some((e) => e.marker?.startsWith("sw:sync:"));
  const stop = await stopServiceWorkers(run);
  const marker = markerFor("wake", iteration);
  await setMarker(run, marker);
  await call(run.extension, `watch(${JSON.stringify({ origin: APP, marker })})`);
  const since = await checkpoint();
  await control("/__network?mode=offline");
  await delay(CUT_MS);
  await control("/__network?mode=online");
  const acted = async () => (await ledger(since)).some(swEffect(WAKE_SCRIPT));
  const woke = await until(acted, WAKE_TIMEOUT_MS);
  const { entries: journal, ...seen } = await call<WatchReport>(run.extension, "unwatch()");
  const entries = await ledger(since);
  const inventory = await clearApp(run, marker);
  const loaded: Loaded = { entries, journal, seen, inventory, report: null, painted: false };
  const { stopped, stopMs } = stop;
  const base = { hypothesis: "wake-without-tab", variant: "sync", mode: "watch" as const, marker };
  const preexisting = namesOf(registered.inventory);
  const sample = sampleOf(
    loaded,
    { ...base, script: WAKE_SCRIPT, store: "fixture-sw", preexisting, stopped, stopMs },
    swEffect(WAKE_SCRIPT),
  );
  const wake: Wake = { syncAtRegistration, stop, woke: woke || journal.length > 0 };
  return { loaded, sample, wake };
}

export async function wakeSamples(run: Run) {
  const results: Awaited<ReturnType<typeof wakeSample>>[] = [];
  for (let iteration = 0; iteration < WAKE_SAMPLES; iteration += 1) {
    results.push(await wakeSample(run, iteration));
  }
  return results;
}
