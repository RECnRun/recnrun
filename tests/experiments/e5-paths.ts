import {
  effectReasons,
  mainReasons,
  markerIn,
  pathOf,
  pausedFor,
  storeReasons,
  unmarked,
} from "./e5-samples.ts";
import type {
  Names,
  NetworkEntry,
  Outcome,
  PausedEntry,
  Reason,
  RouteBJournal,
} from "./e5-samples.ts";

// Pure evaluation of E5's update, offline, and diagnostic paths (tests/experiments/E5-route-b-fetch.spec.ts).
// The fixture's offline.html title, which only the worker's cache can serve while the network is cut.
const OFFLINE_TITLE = "Fixture offline";
const LOOPBACK = "Loopback";

/** What `registration.update()` left (apps/isolator/src/background/route-b/types.ts). */
export interface UpdateOutcome {
  updatefound?: boolean;
  installing?: boolean;
  waiting?: boolean;
  error?: string;
}

/** One update of a registered classic worker, armed with `marker` while it ran. */
export interface UpdateSample {
  variant: "same-marker" | "new-marker";
  marker: string;
  script: string;
  outcome: UpdateOutcome;
  /** The journal of the update alone, from the re-arm to the snapshot. */
  journal: RouteBJournal;
  /** API requests the script's worker made after update() was called. */
  effects: string[];
}

/** One restart of a stored worker in a new tab with the fixture's network cut. */
export interface OfflineSample {
  /** The first load's marker, which the stored wrapped script carries. */
  marker: string;
  script: string;
  store: string;
  /** Whether Chrome listed no running worker on the app origin before the cut. */
  workersGone: boolean;
  firstTransformed: boolean;
  /** The title the offline navigation showed. */
  shown: string;
  /** API requests that reached the fixture during the cut, dropped or not. */
  effects: string[];
  /** The stores read during the cut, after the restart. */
  databases: Names;
  caches: Names;
  network: NetworkEntry[];
}

/** One classic registration with Network events on the worker's session. */
export interface AddressSample {
  variant: "fulfilled" | "control";
  network: NetworkEntry[];
}

/** Where Chrome paused the main script, for the tab-session question. */
export interface TabSessionSample {
  variant: string;
  script: string;
  journal: RouteBJournal;
}

function add(tally: Record<string, number>, key: string): void {
  tally[key] = (tally[key] ?? 0) + 1;
}

const reason = (kind: string, text: string): Reason[] => [{ kind, text }];

function installReasons(sample: UpdateSample, installed: boolean): Reason[] {
  if (sample.variant === "same-marker" && installed) {
    return reason(
      "newVersionInstalled",
      "update() installed a new version for unchanged app bytes",
    );
  }
  if (sample.variant === "new-marker" && !installed) {
    return reason("noNewVersion", "update() installed no new version for a changed wrapper");
  }
  return [];
}

/** Same marker: Chrome must keep the version; new marker: the new version must run wrapped and marked. */
export function evaluateUpdate(sample: UpdateSample): Outcome {
  const { outcome, script, marker } = sample;
  const installed = outcome.updatefound === true || outcome.installing === true;
  const main = pausedFor(sample.journal, script).at(-1);
  const unmarkedEffects = installed
    ? sample.effects.filter((path) => markerIn(path) !== marker)
    : [];
  const reasons = [
    ...(outcome.error === undefined
      ? []
      : reason("updateFailed", `update() failed: ${outcome.error}`)),
    ...installReasons(sample, installed),
    ...(installed ? mainReasons(main, script) : []),
    ...unmarkedEffects.map((path) => ({
      kind: "unmarkedEffect",
      text: `the new version's request without the marker: ${unmarked(path)}`,
    })),
  ];
  return { variant: sample.variant, reasons, ...updateTally(installed, main) };
}

function updateTally(
  installed: boolean,
  main: PausedEntry | undefined,
): Omit<Outcome, "variant" | "reasons"> {
  const tally: Record<string, number> = { installed: installed ? 1 : 0 };
  if (main) tally.updateCheckPaused = 1;
  const transformed = main?.declared === "transformed";
  if (transformed) tally.transformed = 1;
  const waited = transformed && main.waitedMs !== undefined ? [main.waitedMs] : [];
  return { tally, waited };
}

const blockedBy = (entry: NetworkEntry) =>
  entry.corsError !== undefined || entry.blockedReason !== undefined;

/** Chrome's own words for a request it blocked, without the marker so samples group. */
function blockedText(entry: NetworkEntry): string {
  const what = entry.url === undefined ? "a request without a URL" : unmarked(pathOf(entry.url));
  const why = [entry.errorText, entry.corsError, entry.blockedReason].filter(
    (part) => part !== undefined,
  );
  return `Chrome blocked ${what} (${why.join(", ")})`;
}

const variantOf = (script: string) =>
  new URL(script, "http://localhost").searchParams.get("variant") ?? script;

/** The restarted worker ran its stored wrapped script: served the cached page, marked its requests and stores. */
export function evaluateOffline(sample: OfflineSample): Outcome {
  const { marker, store, shown } = sample;
  const blocked = [...new Set(sample.network.filter(blockedBy).map(blockedText))];
  const none = ["no request from the restarted worker reached the fixture", ...blocked].join("; ");
  const reasons = [
    ...(sample.workersGone
      ? []
      : reason("notStopped", "a worker still ran on the app origin when the network was cut")),
    ...(sample.firstTransformed
      ? []
      : reason("notTransformed", `the first load did not fulfill ${sample.script} wrapped`)),
    ...(shown === OFFLINE_TITLE
      ? []
      : reason("notServedOffline", `the offline navigation showed ${shown}`)),
    ...effectReasons(sample.effects, marker, none),
    ...storeReasons("IndexedDB", sample.databases, marker, store),
    ...storeReasons("CacheStorage", sample.caches, marker, store),
  ];
  const marked = sample.network.some(
    (e) => e.url !== undefined && markerIn(pathOf(e.url)) === marker,
  );
  const tally = { servedOffline: shown === OFFLINE_TITLE ? 1 : 0, markedInNetwork: marked ? 1 : 0 };
  return { variant: variantOf(sample.script), reasons, tally, waited: [] };
}

/** Diagnostic: the address space a worker's requests left from, and what Chrome blocked. */
export function evaluateAddress(sample: AddressSample): Outcome {
  const tally: Record<string, number> = {};
  const spaces = new Set<string>();
  for (const space of sample.network.map((entry) => entry.initiatorIPAddressSpace)) {
    if (space === undefined) continue;
    add(tally, `space:${space}`);
    if (space !== LOOPBACK) spaces.add(space);
  }
  const blocked = sample.network.filter(blockedBy);
  // Named apart from the `blocked` kind, whose verdict count is the samples that had one.
  if (blocked.length > 0) tally.blockedRequests = blocked.length;
  const reasons = [
    ...[...spaces].map((space) => ({
      kind: "addressSpace",
      text: `the worker's requests left from address space ${space}`,
    })),
    ...blocked.map((entry) => ({ kind: "blocked", text: blockedText(entry) })),
  ];
  return { variant: sample.variant, reasons, tally, waited: [] };
}

/** Diagnostic: whether the tab's own session ever paused the service worker's main script. */
export function evaluateTabSession(sample: TabSessionSample): Outcome {
  const { script, journal } = sample;
  const tally: Record<string, number> = {};
  for (const entry of journal.paused) add(tally, `${entry.session}:${entry.resourceType}`);
  const main = pausedFor(journal, script);
  const elsewhere = main[0];
  let reasons: Reason[] = [];
  if (main.every((entry) => entry.session !== "tab")) {
    const where = elsewhere
      ? `; Chrome paused it on the ${elsewhere.session} session as ${elsewhere.resourceType}`
      : " or any other";
    reasons = reason("notOnTabSession", `${script} never paused on the tab session${where}`);
  }
  return { variant: sample.variant, reasons, tally, waited: [] };
}
