import type { OriginInventory } from "../browser/observer/storage.ts";
import { CLASSIC } from "./e5-loads.ts";
import type { Loaded, Restarted, Updated } from "./e5-loads.ts";
import type { AddressSample, OfflineSample, UpdateSample } from "./e5-paths.ts";
import { pausedFor } from "./e5-samples.ts";
import type { FirstSample, ImportSample, Names, RouteBJournal } from "./e5-samples.ts";
import { API, fromOf } from "./page-loads.ts";
import type { LedgerEntry } from "./page-loads.ts";

// Samples of E5 (tests/experiments/E5-route-b-fetch.spec.ts) from what each load left, and the capability map.
const STORE = "fixture-sw";
const MISSING = { error: "no inventory of the app origin" };

/** Requests Chrome sent to the fixture's API; the harness's control calls come from Node, with no Sec-Fetch-Dest. */
function effectsOf(entries: LedgerEntry[]): string[] {
  const browserMade = (entry: LedgerEntry) => entry.origin === API && entry.secFetchDest !== null;
  return entries.filter(browserMade).map((entry) => entry.path);
}

function storesOf(inventory: OriginInventory | undefined): { databases: Names; caches: Names } {
  return { databases: inventory?.indexedDB ?? MISSING, caches: inventory?.cacheStorage ?? MISSING };
}

/** What the fixture's page reported for its worker when the worker's start failed. */
function workerErrorOf(report: unknown): string | undefined {
  if (typeof report !== "object" || report === null || !("worker" in report)) return undefined;
  const { worker } = report;
  if (typeof worker !== "object" || worker === null || !("error" in worker)) return undefined;
  return typeof worker.error === "string" ? worker.error : undefined;
}

export function firstSample(
  variant: string,
  script: string,
  marker: string,
  loaded: Loaded,
): FirstSample {
  const workerError = workerErrorOf(loaded.report);
  return {
    variant,
    marker,
    script,
    store: STORE,
    effects: effectsOf(loaded.entries),
    ...storesOf(loaded.inventory),
    journal: loaded.journal,
    ...(workerError === undefined ? {} : { workerError }),
  };
}

export function importSample(
  first: FirstSample,
  imports: string[],
  transform: boolean,
): ImportSample {
  return { variant: first.variant, imports, transform, journal: first.journal };
}

/** The classic worker's requests after update(), which only a newly installed version makes. */
export function updateSample(
  variant: UpdateSample["variant"],
  marker: string,
  updated: Updated,
): UpdateSample {
  return {
    variant,
    marker,
    script: CLASSIC,
    outcome: updated.outcome,
    journal: updated.journal,
    effects: effectsOf(updated.entries).filter((path) => fromOf(path) === CLASSIC),
  };
}

export function offlineSample(marker: string, restarted: Restarted): OfflineSample {
  const first = pausedFor(restarted.first.journal, CLASSIC);
  return {
    marker,
    script: CLASSIC,
    store: STORE,
    workersGone: restarted.workersGone,
    firstTransformed: first.some((entry) => entry.declared === "transformed"),
    shown: restarted.shown,
    effects: effectsOf(restarted.entries),
    ...storesOf(restarted.inventory),
    network: restarted.journal?.network ?? [],
  };
}

export function addressSample(variant: AddressSample["variant"], loaded: Loaded): AddressSample {
  return { variant, network: loaded.journal.network ?? [] };
}

const distinct = (values: (string | undefined)[]) =>
  [...new Set(values.filter((value) => value !== undefined))].sort();

export interface Collected {
  first: FirstSample[];
  imports: ImportSample[];
  updates: UpdateSample[];
  addresses: AddressSample[];
  /** Journals of first registrations armed with the pattern `*`. */
  star: RouteBJournal[];
}

/** The resource types Chrome gave one variant's imports, by session. */
function importTypes(imports: ImportSample[], variant: string): string[] {
  const own = imports.filter((sample) => sample.variant === variant);
  const entries = own.flatMap((s) => s.imports.flatMap((path) => pausedFor(s.journal, path)));
  return distinct(entries.map((entry) => `${entry.session}:${entry.resourceType}`));
}

/** What Route B's run showed Chrome allowing, for capabilities.json. */
export function capabilitiesOf(collected: Collected): Record<string, unknown> {
  const journals = [...collected.first.map((sample) => sample.journal), ...collected.star];
  const tabPaused = journals.flatMap((journal) =>
    journal.paused.filter((e) => e.session === "tab"),
  );
  const mains = collected.first.flatMap((sample) => pausedFor(sample.journal, sample.script));
  const fulfilled = mains.filter((entry) => entry.declared === "transformed");
  const updatePaused = collected.updates.some((u) => pausedFor(u.journal, u.script).length > 0);
  const spaces = collected.addresses
    .filter((sample) => sample.variant === "fulfilled")
    .flatMap((sample) => sample.network.map((entry) => entry.initiatorIPAddressSpace));
  return {
    fetchOnTabSession: {
      enable: distinct(journals.flatMap((journal) => journal.tabs.map((tab) => tab.fetchEnable))),
      pausesServiceWorkerScript: mains.some((entry) => entry.session === "tab"),
      resourceTypes: distinct(tabPaused.map((entry) => entry.resourceType)),
    },
    fetchOnWorkerSession: {
      enable: distinct(journals.flatMap((journal) => journal.workers.map((w) => w.fetchEnable))),
      mainScript: distinct(mains.map((entry) => `${entry.session}:${entry.resourceType}`)),
      importScripts: importTypes(collected.imports, "imports"),
      staticImport: importTypes(collected.imports, "static"),
    },
    fulfillServiceWorkerScript: {
      status: fulfilled.length > 0 ? "allowed" : "rejected",
      transformed: fulfilled.length > 0,
      fulfilled: fulfilled.length,
      of: mains.length,
      errors: distinct(mains.map((entry) => entry.error)),
    },
    updateCheckPaused: updatePaused,
    fulfilledWorkerAddressSpace: distinct(spaces),
  };
}
