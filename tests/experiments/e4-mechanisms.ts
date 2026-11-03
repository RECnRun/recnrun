import type { Page } from "@playwright/test";
import { attempt, baseOf, markersOf, recipeOf, scriptVariant, target } from "./e4-recipes.ts";
import type { Outcome, Plan, Recipe } from "./e4-recipes.ts";
import type { E4Sample, RestartEntry } from "./e4-samples.ts";
import {
  cleanup,
  disarm,
  fire,
  json,
  restartAfter,
  restartOf,
  scriptFetches,
  setMarker,
  sideEffects,
  sleep,
  startWorker,
  stopCall,
  targetInfo,
  unlisted,
  workerRequests,
} from "./e4-steps.ts";
import type { Fired, Started } from "./e4-steps.ts";
import { APP, checkpoint } from "./page-loads.ts";
import type { Run } from "./page-loads.ts";

// One E4 sample: a worker registered under an armed tab, stopped, then given a trigger to start.
/** How long nothing may start the worker again before a trigger tries to. */
const QUIET_MS = 3_000;
const RELEASE_WAIT_MS = 5_000;

interface Watched {
  events: {
    method: string;
    bootstrap?: { installed?: unknown; error?: string };
    released?: string;
  }[];
}

interface Stopped {
  since: number;
  journal: Outcome["journal"];
  unlistedMs: number | null;
  listedAs: unknown;
}

type Restarted = Awaited<ReturnType<typeof restartPhase>>;
type Tab = { page: Page; tabId: number };
type Side = Awaited<ReturnType<typeof sideEffects>> | null;

function reloadOf(watched: Watched | undefined): RestartEntry | undefined {
  const event = watched?.events.find(
    (item) => item.method === "Inspector.targetReloadedAfterCrash",
  );
  if (!event) return undefined;
  const { bootstrap, released } = event;
  const error = bootstrap?.error ?? (released === "ok" ? undefined : released);
  return {
    observedBy: "reload-watch",
    installed: bootstrap?.installed,
    released: released === "ok",
    ...(error === undefined ? {} : { error }),
  };
}

async function applyStop(run: Run, started: Started, recipe: Recipe): Promise<Stopped> {
  const since = await checkpoint();
  const at = Date.now();
  const journal = await attempt(run, started, recipe);
  if (!recipe.held && !recipe.disarmBefore) await disarm(run, started.tabId, started.script);
  if (recipe.closeClient) await started.page.close();
  const unlistedMs = await unlisted(run, started.targetId, at, recipe.unlistedBoundMs);
  const listedAs = unlistedMs === null ? await targetInfo(run, started.targetId) : null;
  await sleep(QUIET_MS);
  return { since, journal, unlistedMs, listedAs };
}

/** Fires the trigger and reads how the extension saw the restart, if one came. */
async function restartPhase(run: Run, started: Started, plan: Plan, held: boolean) {
  const { restartMarker: label } = markersOf(plan);
  if (held) {
    await setMarker(run, label);
    await stopCall(run, `watch(${json({ marker: label })})`);
  }
  const armWith = held ? {} : { armWith: label };
  const fired = await fire(run, started, plan.trigger, { label, ...armWith });
  const first = await restartAfter(fired, started.script);
  const watched = held ? await stopCall<Watched>(run, "unwatch()") : undefined;
  const armedTab = held ? started.tabId : fired.armed;
  const entries = armedTab === undefined ? [] : await disarm(run, armedTab, started.script);
  const entry = entries.find((item) => item.marker === label);
  const restart = reloadOf(watched) ?? restartOf(entry);
  return { fired, first, restart, watched, entries };
}

/** The registration and precache a stop left, as the sample counts them. */
function keptOf(side: Side) {
  return {
    registrationKept: side?.registrationKept ?? null,
    precacheKept: side?.precacheKept ?? null,
  };
}

async function sampleOf(plan: Plan, started: Started, stopped: Stopped, restarted?: Restarted) {
  const { script } = started;
  const until = restarted ? restarted.fired.since : Infinity;
  const restart = restarted?.restart;
  const first = restarted?.first;
  return {
    ...baseOf(plan, script, stopped.journal),
    unlistedMs: stopped.unlistedMs,
    beforeTrigger: await workerRequests(stopped.since, script, until),
    afterTrigger: restarted ? await workerRequests(restarted.fired.since, script) : [],
    ...(first && restarted ? { restartMs: first.ts - restarted.fired.at } : {}),
    ...(restart ? { restart } : {}),
    scriptFetches: await scriptFetches(stopped.since),
  };
}

/** The tabs a sample opened and what the stop left, read on one still on the origin. */
async function leftover(run: Run, plan: Plan, started: Started, fired: Fired | undefined) {
  const tabs: Tab[] = [{ page: started.page, tabId: started.tabId }];
  if (fired?.page && fired.tabId !== undefined) tabs.push({ page: fired.page, tabId: fired.tabId });
  const tab = tabs.find(({ page }) => !page.isClosed() && page.url().startsWith(APP));
  if (!tab) return { tabs, side: null, probe: undefined };
  const side = await sideEffects(run, tab.page, tab.tabId, markersOf(plan).restartMarker);
  const { probe } = recipeOf(plan);
  return { tabs, side, probe: probe ? await probe(run, tab.tabId) : undefined };
}

/** Registers a worker, stops it, waits, fires the trigger, and records what came back. */
async function stopSample(run: Run, plan: Plan): Promise<Outcome> {
  const recipe = recipeOf(plan);
  const started = await startWorker(run, scriptVariant(plan), markersOf(plan).marker);
  if (recipe.disarmBefore) await disarm(run, started.tabId, started.script);
  const stopped = await applyStop(run, started, recipe);
  const held = recipe.held === true;
  const ran = plan.trigger === "none" ? undefined : await restartPhase(run, started, plan, held);
  const { tabs, side, probe } = await leftover(run, plan, started, ran?.fired);
  const sample: E4Sample = { ...(await sampleOf(plan, started, stopped, ran)), ...keptOf(side) };
  await cleanup(run, tabs);
  const restart = ran && {
    trigger: ran.fired.result,
    first: ran.first,
    watched: ran.watched,
    entries: ran.entries,
  };
  const evidence = {
    targetId: started.targetId,
    report: started.report,
    listedAs: stopped.listedAs,
    restart,
    side,
    probe,
  };
  return { sample, journal: stopped.journal, evidence };
}

/** After the release: whether a held navigation finished, and what the worker then did. */
async function afterRelease(fired: Fired, script: string, heldUntil: number) {
  const finished = fired.page
    ? await fired.page.waitForURL(`${APP}/offline.html`, { timeout: RELEASE_WAIT_MS }).then(
        () => true,
        () => false,
      )
    : undefined;
  await sleep(RELEASE_WAIT_MS / 2);
  return { navigationFinished: finished, requests: await workerRequests(heldUntil, script) };
}

/** Pauses the worker, fires the trigger while it is held, then releases it. */
async function pauseSample(run: Run, plan: Plan): Promise<Outcome> {
  const started = await startWorker(run, scriptVariant(plan), markersOf(plan).marker);
  const since = await checkpoint();
  const journal = await attempt(run, started, recipeOf(plan));
  await disarm(run, started.tabId, started.script);
  await sleep(QUIET_MS);
  const fired = await fire(run, started, plan.trigger, { label: markersOf(plan).restartMarker });
  const heldUntil = await checkpoint();
  const listedAs = await targetInfo(run, started.targetId);
  const release = await stopCall(run, `release(${target(started)})`).catch(String);
  const released = await afterRelease(fired, started.script, heldUntil);
  const { tabs, side } = await leftover(run, plan, started, fired);
  const finished = (fired.result as { finished?: unknown }).finished === true;
  const sample: E4Sample = {
    ...baseOf(plan, started.script, journal),
    paused: !("error" in journal) && journal.outcome.paused === true,
    unlistedMs: null,
    beforeTrigger: await workerRequests(since, started.script, fired.since),
    afterTrigger: await workerRequests(fired.since, started.script, heldUntil),
    ...keptOf(side),
    scriptFetches: await scriptFetches(since),
    ...(fired.trigger === "navigation" ? { navigationFinished: finished } : {}),
  };
  await cleanup(run, tabs);
  const evidence = {
    targetId: started.targetId,
    report: started.report,
    listedAs,
    trigger: fired.result,
    release,
    released,
  };
  return { sample, journal, evidence: { ...evidence, side } };
}

export async function runSample(run: Run, plan: Plan): Promise<Outcome> {
  return plan.mechanism === "debugger-pause" ? pauseSample(run, plan) : stopSample(run, plan);
}
