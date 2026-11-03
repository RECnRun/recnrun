// Pure part of E7 (tests/experiments/E7-route-c-pages-workers.spec.ts), so Node unit tests reach it.

// packages/isolation-core/src/marker.ts restated, so the harness checks the bootstrap's effect on its own.
const RESERVED_PREFIX = "__rec:";
const MARKER_PARAM = "__rec";
/** How every error of Route C's worker constructors starts (apps/isolator/src/content/route-c). */
export const REFUSAL = "RECnRun Route C refused";
export const KINDS = [
  "failClosed",
  "unpatched",
  "firstEffectBeforeMarker",
  "unmarkedEffect",
  "staleMarker",
  "injectedUnregistered",
  "noEffect",
  "noReport",
  "workerError",
  "locationChanged",
  "unprefixedIndexedDB",
  "unprefixedCacheStorage",
  "storeMissing",
  "storeUnreadable",
  "openerMessageMissing",
] as const;
// Observations that fail nothing: installMarker covers neither Web Storage area.
export const NOTES = [
  "beforeFirstScript",
  "unprefixedLocalStorage",
  "unprefixedSessionStorage",
] as const;

/** Why a sample failed; `failClosed` is a refused worker, `unpatched` one that ran without the marker. */
export type Kind = (typeof KINDS)[number];
export type Note = (typeof NOTES)[number];
type Names = string[] | { error: string };

/** Store names the load left on its origin; Web Storage lists keys. */
export interface Inventory {
  indexedDB?: Names;
  cacheStorage?: Names;
  localStorage?: Names;
  sessionStorage?: Names;
}

/** One realm in one page load. */
export interface E7Sample {
  hypothesis: string;
  variant: string;
  /** The slot marker Route C was set to for the load. */
  marker: string;
  /** `unmarked` where Route C is not registered, so a marker there means it reached too far. */
  expect: "marked" | "unmarked";
  /** Ledger path of the realm's start marker, its first statement; `null` when it never came. */
  start?: string | null;
  /** Ledger paths of the realm's later fetches, in order. */
  effects: string[];
  /** The name the realm passes to `indexedDB.open()` and `caches.open()`. */
  store?: string;
  inventory?: Inventory;
  /** A worker's script, the `from` of its request (its `location`), and what the page reported. */
  worker?: { script: string; from?: string | undefined; report: unknown };
  /** Whether the opener logged the popup's `fixture-login` message. */
  openerMessage?: boolean;
}

export interface SampleOutcome {
  passed: boolean;
  kinds: Kind[];
  reasons: string[];
  notes: Note[];
}

interface Reason {
  kind: Kind;
  text: string;
}

function markerOf(path: string): string | null {
  return new URL(path, "http://localhost").searchParams.get(MARKER_PARAM);
}

/** The path without the marker parameter, so the same reason groups across iterations. */
function unmarked(path: string): string {
  const at = path.indexOf("?");
  if (at < 0) return path;
  const kept = path
    .slice(at + 1)
    .split("&")
    .filter((pair) => !pair.startsWith(`${MARKER_PARAM}=`));
  return kept.length > 0 ? `${path.slice(0, at)}?${kept.join("&")}` : path.slice(0, at);
}

function isRefused(sample: E7Sample): boolean {
  const report = sample.worker?.report;
  return typeof report === "string" && report.includes(REFUSAL);
}

// A blob: worker's location.pathname is its creator's URL; a data: worker's is its MIME type.
function labelOf(from: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(from)) return "a blob: URL";
  return from.startsWith("/") ? from : "a data: URL";
}

function workerReasons({ worker }: E7Sample): Reason[] {
  if (!worker) return [];
  const { report, from, script } = worker;
  if (typeof report === "string")
    return [{ kind: "noReport", text: `the page got no report: ${report}` }];
  const reasons: Reason[] = [];
  const error: unknown = typeof report === "object" && report ? Reflect.get(report, "error") : null;
  if (typeof error === "string") {
    reasons.push({ kind: "workerError", text: `first statements failed: ${error}` });
  }
  if (from !== undefined && from !== script) {
    const text = `self.location is ${labelOf(from)}, not ${script}`;
    reasons.push({ kind: "locationChanged", text });
  }
  return reasons;
}

function presenceReasons({ start, effects }: E7Sample): Reason[] {
  const reasons: Reason[] = [];
  if (start === null) reasons.push({ kind: "noEffect", text: "no start marker in the ledger" });
  if (effects.length === 0) {
    reasons.push({ kind: "noEffect", text: "no request from the realm in the ledger" });
  }
  return reasons;
}

function pathReason(path: string, marker: string, first: boolean): Reason[] {
  const carried = markerOf(path);
  if (carried === marker) return [];
  if (carried !== null) {
    return [
      { kind: "staleMarker", text: `effect carries ${carried}, not ${marker}: ${unmarked(path)}` },
    ];
  }
  if (first) {
    return [
      {
        kind: "firstEffectBeforeMarker",
        text: `first effect without the marker: ${unmarked(path)}`,
      },
    ];
  }
  return [{ kind: "unmarkedEffect", text: `effect without the marker: ${unmarked(path)}` }];
}

function markReasons(sample: E7Sample): Reason[] {
  const { start, effects, marker } = sample;
  const paths = typeof start === "string" ? [start, ...effects] : effects;
  if (sample.expect === "unmarked") {
    return paths
      .filter((path) => markerOf(path) !== null)
      .map((path) => ({
        kind: "injectedUnregistered",
        text: `marked where Route C is not registered: ${unmarked(path)}`,
      }));
  }
  const bare = paths.length > 0 && paths.every((path) => markerOf(path) === null);
  const unpatched: Reason[] = bare
    ? [{ kind: "unpatched", text: "no request from the realm carries a marker" }]
    : [];
  return [...unpatched, ...paths.flatMap((path, index) => pathReason(path, marker, index === 0))];
}

/** A refused worker should leave nothing behind; any request of its script means one ran anyway. */
function closedReasons({ worker, effects }: E7Sample): Reason[] {
  const reasons: Reason[] = [
    { kind: "failClosed", text: `failed closed: ${String(worker?.report)}` },
  ];
  const [first] = effects;
  if (first !== undefined) {
    reasons.push({ kind: "unpatched", text: `a worker ran after the refusal: ${unmarked(first)}` });
  }
  return reasons;
}

const STORES = {
  indexedDB: { label: "IndexedDB", kind: "unprefixedIndexedDB" },
  cacheStorage: { label: "Cache Storage", kind: "unprefixedCacheStorage" },
} as const;

function storeReasons(sample: E7Sample, which: keyof typeof STORES, closed: boolean): Reason[] {
  const names = sample.inventory?.[which];
  const { store, marker } = sample;
  if (names === undefined || store === undefined) return [];
  const { label, kind } = STORES[which];
  if (!Array.isArray(names)) {
    return [{ kind: "storeUnreadable", text: `${label} unreadable: ${names.error}` }];
  }
  if (names.includes(store)) return [{ kind, text: `${label} holds ${store} without the prefix` }];
  if (closed || names.includes(`${RESERVED_PREFIX}${marker}:${store}`)) return [];
  return [{ kind: "storeMissing", text: `${label} has no ${store} under the load's marker` }];
}

function hasUnprefixed(names: Names | undefined): boolean {
  return Array.isArray(names) && names.some((name) => !name.startsWith(RESERVED_PREFIX));
}

function notesOf({ start, marker, expect, inventory }: E7Sample): Note[] {
  const notes: Note[] = [];
  // The start marker is each page's first statement, so a marked one means Route C ran first.
  if (expect === "marked" && typeof start === "string" && markerOf(start) === marker) {
    notes.push("beforeFirstScript");
  }
  if (hasUnprefixed(inventory?.localStorage)) notes.push("unprefixedLocalStorage");
  if (hasUnprefixed(inventory?.sessionStorage)) notes.push("unprefixedSessionStorage");
  return notes;
}

function openerReasons({ hypothesis, openerMessage }: E7Sample): Reason[] {
  if (openerMessage !== false) return [];
  const [who, message] =
    hypothesis === "popup" ? ["opener", "fixture-login"] : ["parent", "fixture-renew"];
  return [{ kind: "openerMessageMissing", text: `the ${who} got no ${message} message` }];
}

/** A sample passes when every request of the realm carries the expected marker and its stores the prefix. */
export function evaluateSample(sample: E7Sample): SampleOutcome {
  const closed = isRefused(sample);
  const reasons = [
    ...(closed
      ? closedReasons(sample)
      : [...workerReasons(sample), ...presenceReasons(sample), ...markReasons(sample)]),
    ...storeReasons(sample, "indexedDB", closed),
    ...storeReasons(sample, "cacheStorage", closed),
    ...openerReasons(sample),
  ];
  return {
    passed: reasons.length === 0,
    kinds: [...new Set(reasons.map((reason) => reason.kind))],
    reasons: reasons.map((reason) => reason.text),
    notes: notesOf(sample),
  };
}

/** One ledger row, as `/__ledger` returns it. */
export interface LedgerRow {
  seq: number;
  origin: string;
  path: string;
  secFetchDest: string | null;
  marker: string | null;
}

/** The realm's start marker and the fetches on `origins` after it; documents and scripts are no effects. */
export function realmPaths(entries: LedgerRow[], startName: string, origins: string[]) {
  const at = entries.findIndex((entry) => entry.marker === startName);
  const start = entries[at];
  if (!start) return { start: null, effects: [] as string[] };
  const effects = entries
    .slice(at + 1)
    .filter((entry) => entry.secFetchDest === "empty" && origins.includes(entry.origin))
    .map((entry) => entry.path);
  return { start: start.path, effects };
}

export type WorkerRealm = "dedicated" | "shared";
const REALMS: WorkerRealm[] = ["dedicated", "shared"];

/** The worker's `location.pathname + location.search`, which a data: wrapper fills with its source. */
function fromOf(path: string): string {
  const from = new URL(path, "http://localhost").searchParams.get("from") ?? "";
  try {
    return decodeURIComponent(from);
  } catch {
    return from;
  }
}

/**
 * The `/me?from=` request of each worker: the one naming its script first, then blob: wrapper URLs,
 * which name nothing, in construction order to the workers not refused (dedicated before shared).
 */
export function attributeWorkers(
  paths: string[],
  scripts: Record<WorkerRealm, string>,
  reports: Partial<Record<WorkerRealm, unknown>>,
): Partial<Record<WorkerRealm, string>> {
  const requests = paths.filter((path) => fromOf(path) !== "");
  const names = (path: string, realm: WorkerRealm) => fromOf(path).includes(scripts[realm]);
  const own = (realm: WorkerRealm) => requests.find((path) => names(path, realm));
  const foreign = requests.filter((path) => !REALMS.some((realm) => names(path, realm)));
  const refused = (realm: WorkerRealm) => String(reports[realm]).includes(REFUSAL);
  const owned: Partial<Record<WorkerRealm, string>> = {};
  for (const realm of REALMS) {
    const path = own(realm) ?? (refused(realm) ? undefined : foreign.shift());
    if (path !== undefined) owned[realm] = path;
  }
  return owned;
}
