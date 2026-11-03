import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ISOLATOR_PATH } from "../browser/fixtures/extension.ts";
import type { LoadedExtension } from "../browser/fixtures/extension.ts";
import { loadUnpackedOverCdp } from "../browser/fixtures/extension-loaders.ts";
import { arm, PATTERN, register, reset, snapshot, stopWorkers, waitUntil } from "./e5-loads.ts";
import type { ArmOptions, Armed } from "./e5-loads.ts";
import { browserOf } from "./e1-aggregate.ts";
import type { E1Browser } from "./e1-aggregate.ts";
import type { UpdateOutcome } from "./e5-paths.ts";
import type { Suspension, SwitchSample } from "./e6-samples.ts";
import { disarm, errorOf, namesOf, newTab, restartService, runningAfter } from "./e6-loads.ts";
import { scriptFetches, select, settle, slotName } from "./e6-loads.ts";
import { APP, checkpoint, control, inventoryOf, isolator, prepareFixture } from "./page-loads.ts";
import { targetsLeft } from "./page-loads.ts";
import type { Run } from "./page-loads.ts";

// E6's paths beyond a switch: update(), a suspended background, an offline start, a Chrome restart.
const FETCH_IMPORT: ArmOptions = { selection: "fetch-import" };
const SW_STORE = "fixture-sw";
const SCOPE_PAGE = `${APP}/storage.html`;
const SUSPEND_WAIT_MS = 5_000;

/** What `recnrunSelection.status()` answers (apps/isolator/src/background/selection/types.ts). */
interface SelectionStatus {
  timeOrigin: number;
  wakes: { event: string; at: number }[];
  suspend: { attach?: string; close?: string } | null;
  ruleIds: number[];
}

const status = (run: Run) => isolator<SelectionStatus>(run.extension, "recnrunSelection.status()");

const base = (before: number, after: number) => ({
  realm: "service" as const,
  selection: "fetch-import",
  timing: "late" as const,
  before: slotName(before),
  after: slotName(after),
  store: SW_STORE,
});

async function backgroundListed(run: Run): Promise<boolean> {
  const { targetInfos } = await run.extension.chrome.cdp.send("Target.getTargets");
  const origin = `chrome-extension://${run.extension.extensionId}/`;
  return targetInfos.some((t) => t.type === "service_worker" && t.url.startsWith(origin));
}

/** Closes the isolator's own background, then opens a tab, whose `tabs.onCreated` starts it again. */
export async function suspendBackground(run: Run): Promise<Suspension> {
  const before = await status(run);
  const error = await isolator(run.extension, "recnrunSelection.suspend()").then(
    () => undefined,
    (thrown: Error) => thrown.message,
  );
  const gone = async () => !(await backgroundListed(run));
  const suspended = error === undefined && (await waitUntil(gone, SUSPEND_WAIT_MS));
  const wake = await run.context.newPage();
  const after = await status(run);
  await wake.close();
  const resumed = after.timeOrigin !== before.timeOrigin;
  return { suspended, resumed, before, after, ...(error === undefined ? {} : { error }) };
}

/** A worker installed under `before`, the selection switched to `after`, then `registration.update()`. */
export async function updateService(run: Run, before: number, after: number) {
  await select(run, before);
  const registered = await register(run, "classic", slotName(before), FETCH_IMPORT);
  const { armed } = registered;
  await disarm(run, armed);
  const first = namesOf(await inventoryOf(run, armed.page, "update-first"));
  const { updateMs } = await select(run, after);
  const rearm = { ...JSON.parse(armed.tab), marker: slotName(after), urlPattern: PATTERN };
  await isolator(
    run.extension,
    `recnrunRouteB.arm(${JSON.stringify({ ...rearm, ...FETCH_IMPORT })})`,
  );
  const since = await checkpoint();
  const startedAt = performance.now();
  const outcome = await isolator<UpdateOutcome>(
    run.extension,
    `recnrunRouteB.update(${armed.tab})`,
  );
  const journal = await disarm(run, armed);
  const settled = await settle(run, armed);
  const activatedMs = settled ? Math.round(performance.now() - startedAt) : null;
  const second = namesOf(await inventoryOf(run, armed.page, "update-second"));
  const sample: SwitchSample = {
    ...base(before, after),
    first,
    second,
    started: outcome.updatefound === true,
    running: await runningAfter(since),
    switchMs: updateMs,
    journal,
  };
  await reset(run, armed);
  return { sample, outcome, activatedMs };
}

/** Opens the scope page with the fixture offline, then reads the journal, the stores, and the targets. */
async function startOffline(run: Run, armed: Armed) {
  await control("/__network?mode=offline");
  try {
    const shown = await armed.page.goto(SCOPE_PAGE).then(
      () => armed.page.title(),
      (error: Error) => error.message,
    );
    const listed = (await targetsLeft(run, "service_worker")).length > 0;
    const journal = await disarm(run, armed);
    const second = namesOf(await inventoryOf(run, armed.page, "offline-restart"));
    return { shown, listed, journal, second };
  } finally {
    await control("/__network?mode=online");
  }
}

/** A worker installed under `before`, stopped, and started again with the fixture offline. */
export async function offlineService(run: Run, before: number, after: number) {
  await select(run, before);
  const registered = await register(run, "classic", slotName(before), FETCH_IMPORT);
  const first = await snapshot(run, registered, slotName(before));
  const settled = await settle(run, registered.armed);
  await registered.armed.page.close();
  const { workersGone } = await stopWorkers(run);
  const options = { ...FETCH_IMPORT, network: true };
  const armed = await arm(run, await newTab(run), slotName(after), options);
  const fetches = await scriptFetches(registered.since);
  const since = await checkpoint();
  // Everything is read before the network returns, since an online navigation installs the original.
  const offline = await startOffline(run, armed);
  const started = workersGone && offline.listed;
  const running = await runningAfter(since, offline.journal);
  await reset(run, armed);
  const sample: SwitchSample = {
    ...base(before, after),
    first: namesOf(first.inventory),
    second: offline.second,
    started,
    running,
    switchMs: 0,
    settled,
    scriptFetches: fetches,
    journal: offline.journal,
  };
  return { sample, shown: offline.shown };
}

const runOf = (extension: LoadedExtension): Run => {
  const [context] = extension.chrome.browser.contexts();
  if (!context) throw new Error("Chrome has no default browser context");
  return { extension, context };
};

export interface ChromeRestart {
  browser: E1Browser;
  sample?: SwitchSample;
  /** The selection's session rules the relaunched background found. */
  rulesAfter?: number;
  /** Why the relaunch on the same profile failed. */
  error?: string;
}

/** Installs under `slot` in a new profile, closes Chrome, relaunches it on that profile, restarts the worker. */
export async function restartChrome(slot: number): Promise<ChromeRestart> {
  const profile = await mkdtemp(join(tmpdir(), "recnrun-e6-profile-"));
  try {
    const { browser, ...first } = await installOn(profile, slot);
    let extension: LoadedExtension;
    try {
      extension = await loadUnpackedOverCdp(ISOLATOR_PATH, { userDataDir: profile });
    } catch (error) {
      return { browser, error: `relaunch on the same profile: ${(error as Error).message}` };
    }
    try {
      const run = runOf(extension);
      const rules = await isolator<unknown[]>(extension, "recnrunSelection.rules()");
      const restarted = await restartService(run, slotName(slot), FETCH_IMPORT);
      await reset(run, restarted.armed);
      const { second, started, stalled, restartMs, running, journal } = restarted;
      const after = { second, started, stalled, restartMs, running, journal };
      const sample = { ...base(slot, slot), ...first, ...after };
      return { browser, sample, rulesAfter: rules.length };
    } finally {
      await extension.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** The first Chrome on `profile`: selects `slot`, registers the worker, and closes Chrome. */
async function installOn(profile: string, slot: number) {
  const extension = await loadUnpackedOverCdp(ISOLATOR_PATH, { userDataDir: profile });
  try {
    const run = runOf(extension);
    await prepareFixture(extension);
    const { updateMs } = await select(run, slot);
    const registered = await register(run, "classic", slotName(slot), FETCH_IMPORT);
    const loaded = await snapshot(run, registered, slotName(slot));
    const settled = await settle(run, registered.armed);
    const error = errorOf(loaded.report, "worker");
    return {
      browser: browserOf(extension),
      first: namesOf(loaded.inventory),
      switchMs: updateMs,
      settled,
      scriptFetches: await scriptFetches(registered.since),
      ...(error === undefined ? {} : { error }),
    };
  } finally {
    await extension.close();
  }
}
