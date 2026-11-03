import { provenance } from "./e1-aggregate.ts";
import type { E1Browser } from "./e1-aggregate.ts";
import type { Verdict } from "./verdicts.ts";

// Pure part of E5 (tests/experiments/E5-route-b-fetch.spec.ts), so Node unit tests reach it.
const EXPERIMENT = "E5";
// packages/isolation-core/src/marker.ts restated, so the harness checks the bootstrap's effect on its own.
const RESERVED_PREFIX = "__rec:";
const MARKER_PARAM = "__rec";

/** One request Route B saw paused (apps/isolator/src/background/route-b/types.ts). */
export interface PausedEntry {
  session: "tab" | "worker";
  url: string;
  resourceType: string;
  stage: string;
  role?: "main" | "imported";
  status?: number;
  errorReason?: string;
  action: string;
  declared?: string;
  wrapper?: string;
  originalBytes?: number;
  fulfilledBytes?: number;
  waitedMs?: number;
  error?: string;
}

export interface WorkerEntry {
  targetId: string;
  type: string;
  url: string;
  waitingForDebugger: boolean;
  fetchEnable: string;
  networkEnable?: string;
  released: boolean;
  error?: string;
}

/** A worker's request as its session's Network events reported it (the `network` diagnostic). */
export interface NetworkEntry {
  requestId: string;
  url?: string;
  initiatorIPAddressSpace?: string;
  requestPolicy?: string;
  errorText?: string;
  blockedReason?: string;
  corsError?: string;
}

export interface RouteBJournal {
  tabs: { tabId: number; marker: string; fetchEnable: string }[];
  workers: WorkerEntry[];
  paused: PausedEntry[];
  network?: NetworkEntry[];
}

export interface Reason {
  kind: string;
  text: string;
}

/** One sample's evaluation: why it failed, named tallies, and how long its paused requests waited. */
export interface Outcome {
  variant: string;
  reasons: Reason[];
  tally: Record<string, number>;
  waited: number[];
}

export type Names = string[] | { error: string };

/** One armed first registration: the main script, the worker's API requests, and its stores. */
export interface FirstSample {
  variant: string;
  marker: string;
  script: string;
  store: string;
  effects: string[];
  databases: Names;
  caches: Names;
  journal: RouteBJournal;
  /** What the worker reported to the page when its start failed, for example a rejected fetch. */
  workerError?: string;
}

/** The scripts a worker imports, and whether Route B was asked to wrap them too. */
export interface ImportSample {
  variant: string;
  imports: string[];
  transform: boolean;
  journal: RouteBJournal;
}

export function pathOf(url: string): string {
  const parsed = new URL(url, "http://localhost");
  return parsed.pathname + parsed.search;
}

export function markerIn(path: string): string | null {
  return new URL(path, "http://localhost").searchParams.get(MARKER_PARAM);
}

/** The path without the marker parameter, so the same reason groups across samples. */
export function unmarked(path: string): string {
  const at = path.indexOf("?");
  if (at < 0) return path;
  const kept = path
    .slice(at + 1)
    .split("&")
    .filter((pair) => !pair.startsWith(`${MARKER_PARAM}=`));
  return kept.length > 0 ? `${path.slice(0, at)}?${kept.join("&")}` : path.slice(0, at);
}

/** The first effect must carry the marker, then every later one; `none` says why none came. */
export function effectReasons(effects: string[], marker: string, none: string): Reason[] {
  const [first, ...later] = effects;
  if (first === undefined) return [{ kind: "noEffect", text: none }];
  const reasons: Reason[] = [];
  if (markerIn(first) !== marker) {
    const text = `first effect without the marker: ${unmarked(first)}`;
    reasons.push({ kind: "firstEffectBeforeMarker", text });
  }
  for (const path of later.filter((item) => markerIn(item) !== marker)) {
    reasons.push({ kind: "unmarkedEffect", text: `effect without the marker: ${unmarked(path)}` });
  }
  return reasons;
}

/** A store the worker opened without the prefix ran before the bootstrap. */
export function storeReasons(kind: string, names: Names, marker: string, store: string): Reason[] {
  if (!Array.isArray(names)) {
    return [{ kind: "storeUnreadable", text: `${kind} unreadable: ${names.error}` }];
  }
  if (names.includes(store)) {
    return [{ kind: `storeUnprefixed:${kind}`, text: `${kind} holds ${store} without the prefix` }];
  }
  if (!names.includes(`${RESERVED_PREFIX}${marker}:${store}`)) {
    return [{ kind: "storeMissing", text: `${kind} has no ${store} under this marker` }];
  }
  return [];
}

export function pausedFor(journal: RouteBJournal, path: string): PausedEntry[] {
  return journal.paused.filter((entry) => pathOf(entry.url) === path);
}

function notFulfilled(path: string, entry: PausedEntry): string {
  const why = entry.error ?? entry.action;
  return `${path} paused on the ${entry.session} session (${entry.resourceType}) but not fulfilled: ${why}`;
}

export function mainReasons(main: PausedEntry | undefined, script: string): Reason[] {
  if (main === undefined) {
    const text = `no Fetch.requestPaused for ${script} on the tab or worker session`;
    return [{ kind: "notIntercepted", text }];
  }
  if (main.declared === "transformed") return [];
  return [{ kind: "notTransformed", text: notFulfilled(script, main) }];
}

export function evaluateFirst(sample: FirstSample): Outcome {
  const { script, marker, store, journal } = sample;
  const main = pausedFor(journal, script).at(-1);
  const released = journal.workers.some((w) => pathOf(w.url) === script && w.released);
  const reported = sample.workerError ? `; the worker reported ${sample.workerError}` : "";
  const none = `no request from ${script} reached the fixture${reported}`;
  const reasons = [
    ...mainReasons(main, script),
    ...(released
      ? []
      : [{ kind: "notReleased", text: `no paused worker target released for ${script}` }]),
    ...effectReasons(sample.effects, marker, none),
    ...storeReasons("IndexedDB", sample.databases, marker, store),
    ...storeReasons("CacheStorage", sample.caches, marker, store),
  ];
  const tally: Record<string, number> = {};
  if (main?.declared === "transformed") tally.transformed = 1;
  if (main) tally[`main:${main.session}:${main.resourceType}`] = 1;
  const waited =
    main?.declared === "transformed" && main.waitedMs !== undefined ? [main.waitedMs] : [];
  return { variant: sample.variant, reasons, tally, waited };
}

function add(tally: Record<string, number>, key: string): void {
  tally[key] = (tally[key] ?? 0) + 1;
}

export function evaluateImports(sample: ImportSample): Outcome {
  const tally: Record<string, number> = { imports: sample.imports.length };
  const reasons: Reason[] = [];
  const waited: number[] = [];
  for (const path of sample.imports) {
    const entries = pausedFor(sample.journal, path);
    const entry = entries.find((e) => e.session === "worker") ?? entries[0];
    if (entry === undefined) {
      add(tally, "notIntercepted");
      const text = `${path} never paused on the tab or worker session`;
      reasons.push({ kind: "importNotIntercepted", text });
      continue;
    }
    add(tally, `intercepted:${entry.session}`);
    add(tally, `import:${entry.session}:${entry.resourceType}`);
    if (entry.declared === "transformed") {
      add(tally, "transformed");
      if (entry.waitedMs !== undefined) waited.push(entry.waitedMs);
    } else if (sample.transform) {
      reasons.push({ kind: "importNotTransformed", text: notFulfilled(path, entry) });
    }
  }
  return { variant: sample.variant, reasons, tally, waited };
}

/** Every distinct reason with how often it happened, or `undefined` when every sample passed. */
function failureOf(outcomes: Outcome[]): string | undefined {
  if (outcomes.length === 0) return "no sample ran";
  const failed = outcomes.filter((outcome) => outcome.reasons.length > 0).length;
  if (failed === 0) return undefined;
  const counted = new Map<string, number>();
  for (const { text } of outcomes.flatMap((outcome) => outcome.reasons)) {
    counted.set(text, (counted.get(text) ?? 0) + 1);
  }
  const listed = [...counted].map(([text, count]) => `${text} (${count})`).join("; ");
  return `${failed} of ${outcomes.length} samples failed: ${listed}`;
}

/** Samples, passes, samples per failure kind (zero included), and every tally summed. */
function countsOf(outcomes: Outcome[], kinds: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {
    samples: outcomes.length,
    passed: outcomes.filter((outcome) => outcome.reasons.length === 0).length,
  };
  for (const kind of kinds) {
    counts[kind] = outcomes.filter((o) => o.reasons.some((r) => r.kind === kind)).length;
  }
  for (const [key, value] of outcomes.flatMap((outcome) => Object.entries(outcome.tally))) {
    counts[key] = (counts[key] ?? 0) + value;
  }
  return counts;
}

/** Nearest-rank percentile of ascending `sorted`, to a tenth of a millisecond. */
function percentile(sorted: number[], p: number): number {
  const value = sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  return Math.round(value * 10) / 10;
}

function timingsOf(outcomes: Outcome[]): Verdict["timings"] {
  const values = outcomes.flatMap((outcome) => outcome.waited).sort((a, b) => a - b);
  if (values.length === 0) return undefined;
  const pausedMs = {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: percentile(values, 100),
  };
  return { pausedMs };
}

function variantsOf(outcomes: Outcome[]): Verdict["variants"] {
  const names = [...new Set(outcomes.map((outcome) => outcome.variant))];
  return names.map((name) => {
    const own = outcomes.filter((outcome) => outcome.variant === name);
    const error = failureOf(own);
    const verdict: Verdict["verdict"] = error === undefined ? "pass" : "fail";
    return { name, verdict, ...(error === undefined ? {} : { error }), samples: own.length };
  });
}

export interface VerdictOptions {
  /** Failure kinds counted even when no sample had them, so a zero is explicit. */
  kinds: readonly string[];
  label?: Verdict["label"];
}

/** The hypothesis passes only when every sample passed; otherwise the counts say how it failed. */
export function verdictOf(
  hypothesis: string,
  outcomes: Outcome[],
  browser: E1Browser,
  options: VerdictOptions,
): Verdict {
  const error = failureOf(outcomes);
  const timings = timingsOf(outcomes);
  return {
    experiment: EXPERIMENT,
    hypothesis,
    verdict: error === undefined ? "pass" : "fail",
    ...(error === undefined ? {} : { error }),
    chrome: browser.chrome,
    samples: outcomes.length,
    ...(options.label ? { label: options.label } : {}),
    ...provenance(browser),
    counts: countsOf(outcomes, options.kinds),
    ...(timings ? { timings } : {}),
    variants: variantsOf(outcomes),
  };
}
