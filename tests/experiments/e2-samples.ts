import { provenance } from "./e1-aggregate.ts";
import type { E1Browser } from "./e1-aggregate.ts";
import type { Verdict } from "./verdicts.ts";

// Pure part of E2 (tests/experiments/E2-route-a-register.spec.ts), so Node unit tests reach it.
const EXPERIMENT = "E2";
// packages/isolation-core/src/marker.ts restated, so the harness checks the bootstrap's effect on its own.
const RESERVED_PREFIX = "__rec:";
const MARKER_PARAM = "__rec";
const KINDS = [
  "firstEffectBeforeMarker",
  "unmarkedEffect",
  "notAttached",
  "notPaused",
  "bootstrapFailed",
  "notReleased",
  "noEffect",
  "storeUnreadable",
] as const;

/** Why a sample failed; `firstEffectBeforeMarker` means the worker acted before the bootstrap. */
export type Kind = (typeof KINDS)[number];

/** The part of an isolator journal entry E2 reads (apps/isolator/src/background/route-a/types.ts). */
export interface JournalEntry {
  type: string;
  url: string;
  waitingForDebugger: boolean;
  bootstrapMs?: number;
  installed?: unknown;
  released: boolean;
  error?: string;
}

/** One worker in one armed page load. */
export interface E2Sample {
  hypothesis: string;
  variant: string;
  marker: string;
  /** The worker script, path and query, as its `location.pathname + location.search`. */
  script: string;
  /** The name the worker passes to `indexedDB.open()` and `caches.open()` as its first statements. */
  store: string;
  /** Ledger paths of the worker's requests after the load's checkpoint, in order. */
  effects: string[];
  databases: string[] | { error: string };
  caches: string[] | { error: string };
  /** The journal entry whose URL is the script's, when Route A attached the worker. */
  entry?: JournalEntry;
}

export interface SampleOutcome {
  passed: boolean;
  kinds: Kind[];
  reasons: string[];
}

interface Reason {
  kind: Kind;
  text: string;
}

function isMarked(path: string, marker: string): boolean {
  return new URL(path, "http://localhost").searchParams.get(MARKER_PARAM) === marker;
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

function attachReasons({ entry, marker, script }: E2Sample): Reason[] {
  if (!entry) return [{ kind: "notAttached", text: `no Target.attachedToTarget for ${script}` }];
  if (!entry.waitingForDebugger) {
    return [{ kind: "notPaused", text: "attached while running, not waiting for the debugger" }];
  }
  const reasons: Reason[] = [];
  const installed = (entry.installed as { marker?: unknown } | undefined)?.marker;
  if (entry.error !== undefined) {
    reasons.push({ kind: "bootstrapFailed", text: `bootstrap failed: ${entry.error}` });
  } else if (installed !== marker) {
    const text = `bootstrap answered ${JSON.stringify(entry.installed)}`;
    reasons.push({ kind: "bootstrapFailed", text });
  }
  if (!entry.released) reasons.push({ kind: "notReleased", text: "never released" });
  return reasons;
}

function effectReasons({ effects, marker, script }: E2Sample): Reason[] {
  const [first, ...later] = effects;
  if (first === undefined) {
    return [{ kind: "noEffect", text: `no request from ${script} in the ledger` }];
  }
  const reasons: Reason[] = [];
  if (!isMarked(first, marker)) {
    const text = `first effect without the marker: ${unmarked(first)}`;
    reasons.push({ kind: "firstEffectBeforeMarker", text });
  }
  for (const path of later.filter((item) => !isMarked(item, marker))) {
    reasons.push({ kind: "unmarkedEffect", text: `effect without the marker: ${unmarked(path)}` });
  }
  return reasons;
}

function storeReasons(
  kind: string,
  names: string[] | { error: string },
  { marker, store }: E2Sample,
): Reason[] {
  if (!Array.isArray(names)) {
    return [{ kind: "storeUnreadable", text: `${kind} unreadable: ${names.error}` }];
  }
  if (names.includes(store)) {
    return [{ kind: "firstEffectBeforeMarker", text: `${kind} holds ${store} without the prefix` }];
  }
  if (!names.includes(`${RESERVED_PREFIX}${marker}:${store}`)) {
    return [{ kind: "noEffect", text: `${kind} has no ${store} under this marker` }];
  }
  return [];
}

/** A sample passes when the worker waited, took the bootstrap, and every effect carries the marker. */
export function evaluateSample(sample: E2Sample): SampleOutcome {
  const reasons = [
    ...attachReasons(sample),
    ...effectReasons(sample),
    ...storeReasons("IndexedDB", sample.databases, sample),
    ...storeReasons("Cache Storage", sample.caches, sample),
  ];
  return {
    passed: reasons.length === 0,
    kinds: [...new Set(reasons.map((reason) => reason.kind))],
    reasons: reasons.map((reason) => reason.text),
  };
}

/** Every distinct reason with how often it happened, or `undefined` when every sample passed. */
function failureOf(outcomes: SampleOutcome[]): string | undefined {
  if (outcomes.length === 0) return "no sample ran";
  const failed = outcomes.filter((outcome) => !outcome.passed).length;
  if (failed === 0) return undefined;
  const counted = new Map<string, number>();
  for (const reason of outcomes.flatMap((outcome) => outcome.reasons)) {
    counted.set(reason, (counted.get(reason) ?? 0) + 1);
  }
  const listed = [...counted].map(([text, count]) => `${text} (${count})`).join("; ");
  return `${failed} of ${outcomes.length} samples failed: ${listed}`;
}

function countsOf(outcomes: SampleOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {
    passed: outcomes.filter((outcome) => outcome.passed).length,
  };
  for (const kind of KINDS) {
    counts[kind] = outcomes.filter((outcome) => outcome.kinds.includes(kind)).length;
  }
  return counts;
}

/** Nearest-rank percentile of ascending `sorted`, to a tenth of a millisecond. */
function percentile(sorted: number[], p: number): number {
  const value = sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  return Math.round(value * 10) / 10;
}

function timingsOf(samples: E2Sample[]): Verdict["timings"] {
  const values = samples
    .flatMap(({ entry }) => (entry?.bootstrapMs === undefined ? [] : [entry.bootstrapMs]))
    .sort((a, b) => a - b);
  if (values.length === 0) return undefined;
  const bootstrapMs = {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: percentile(values, 100),
  };
  return { bootstrapMs };
}

function variantsOf(samples: E2Sample[], outcomes: SampleOutcome[]): Verdict["variants"] {
  const names = [...new Set(samples.map((sample) => sample.variant))];
  return names.map((name) => {
    const own = outcomes.filter((_, index) => samples[index]?.variant === name);
    const error = failureOf(own);
    const verdict: Verdict["verdict"] = error === undefined ? "pass" : "fail";
    return { name, verdict, ...(error === undefined ? {} : { error }), samples: own.length };
  });
}

/** The hypothesis passes only when every sample passed; otherwise the counts say how it failed. */
export function summarize(hypothesis: string, samples: E2Sample[], browser: E1Browser): Verdict {
  const outcomes = samples.map((sample) => evaluateSample(sample));
  const error = failureOf(outcomes);
  const timings = timingsOf(samples);
  return {
    experiment: EXPERIMENT,
    hypothesis,
    verdict: error === undefined ? "pass" : "fail",
    ...(error === undefined ? {} : { error }),
    chrome: browser.chrome,
    samples: samples.length,
    ...provenance(browser),
    counts: countsOf(outcomes),
    ...(timings ? { timings } : {}),
    variants: variantsOf(samples, outcomes),
  };
}

/** A hypothesis the fixture or the browser gives no way to test. */
export function unavailable(hypothesis: string, error: string, browser: E1Browser): Verdict {
  return {
    experiment: EXPERIMENT,
    hypothesis,
    verdict: "unavailable",
    error,
    chrome: browser.chrome,
    samples: 0,
    ...provenance(browser),
  };
}
