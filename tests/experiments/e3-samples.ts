import { provenance } from "./e1-aggregate.ts";
import type { E1Browser } from "./e1-aggregate.ts";
import { failureOf, isMarked, percentile, skippedPatch, unmarked } from "./e2-samples.ts";
import type { Verdict } from "./verdicts.ts";

// Pure part of E3 (tests/experiments/E3-route-a-cold.spec.ts), so Node unit tests reach it.
const EXPERIMENT = "E3";
// packages/isolation-core/src/marker.ts restated, so the harness checks the bootstrap's effect on its own.
const RESERVED_PREFIX = "__rec:";
const PREPARE_STEPS = new Set(["Debugger.enable", "Debugger.setInstrumentationBreakpoint"]);
const KINDS = [
  "firstEffectBeforeMarker",
  "lateAttach",
  "unmarkedEffect",
  "notStopped",
  "notAttached",
  "breakpointRefused",
  "notPaused",
  "notReleased",
  "bootstrapFailed",
  "noEffect",
  "storeUnreadable",
] as const;

/** Why a sample failed; `firstEffectBeforeMarker` and `lateAttach` mean the bootstrap came late. */
export type Kind = (typeof KINDS)[number];

const LATE: readonly Kind[] = ["firstEffectBeforeMarker", "lateAttach"];

/** How Route A reached the worker: armed with pauseBeforeScript, `watch`, or `attachTarget`. */
export type Mode = "pause" | "watch" | "direct";

export interface PauseRecord {
  steps: { step: string; result: string }[];
  paused: boolean;
  pausedMs?: number;
  typeofAtPause?: unknown;
  laterPauses: number;
}

/** The part of an isolator journal entry E3 reads (apps/isolator/src/background/route-a/types.ts). */
export interface E3Entry {
  type: string;
  url: string;
  waitingForDebugger: boolean;
  bootstrapMs?: number;
  attachMs?: number;
  installed?: unknown;
  released: boolean;
  error?: string;
  pause?: PauseRecord;
}

/** One worker in one page load, or one wake. */
export interface E3Sample {
  hypothesis: string;
  /** The sub-case the verdict reports apart, such as the service-worker variant or the mode. */
  variant: string;
  mode: Mode;
  marker: string;
  /** The worker script, path and query, as its `location.pathname + location.search`. */
  script: string;
  /** The name the worker passes to `indexedDB.open()` and `caches.open()` as its first statements. */
  store: string;
  /** Ledger paths of the worker's requests after the load's checkpoint, in order. */
  effects: string[];
  databases: string[] | { error: string };
  caches: string[] | { error: string };
  /** Store names the origin held before the load; only a name the load created counts against it. */
  preexisting?: string[];
  /** Whether the worker was stopped before the load, for a load that needs it stopped. */
  stopped?: boolean;
  /** Milliseconds from asking the worker to stop until Chrome no longer listed it. */
  stopMs?: number;
  /** The journal entry whose URL is the script's, when Route A attached the worker. */
  entry?: E3Entry;
}

export interface SampleOutcome {
  passed: boolean;
  kinds: Kind[];
  reasons: string[];
}

/** Where the verdicts came from: the browser and the stress condition of the run. */
export interface Context {
  browser: E1Browser;
  condition: string;
}

interface Reason {
  kind: Kind;
  text: string;
}

/** The script a `/me?from=` request names; a controlling, instrumented service worker marks its URL. */
export function fromOf(path: string): string | null {
  const from = new URL(path, "http://localhost").searchParams.get("from");
  return from === null ? null : unmarked(from);
}

/** A worker the tab's auto-attach held must have paused at its breakpoint and been resumed. */
function pauseReasons(entry: E3Entry): Reason[] {
  if (!entry.waitingForDebugger) {
    return [{ kind: "lateAttach", text: "attached while running, not waiting for the debugger" }];
  }
  const steps = entry.pause?.steps ?? [];
  const reasons: Reason[] = steps
    .filter(({ step, result }) => PREPARE_STEPS.has(step) && result !== "ok")
    .map(({ step, result }) => ({ kind: "breakpointRefused", text: `${step}: ${result}` }));
  if (!entry.pause?.paused) reasons.push({ kind: "notPaused", text: "no instrumentation pause" });
  if (!entry.released) reasons.push({ kind: "notReleased", text: "never released" });
  const resume = steps.find(({ step, result }) => step === "Debugger.resume" && result !== "ok");
  if (resume) reasons.push({ kind: "notReleased", text: `Debugger.resume: ${resume.result}` });
  return reasons;
}

function bootstrapReasons(entry: E3Entry, marker: string): Reason[] {
  if (entry.error !== undefined) {
    return [{ kind: "bootstrapFailed", text: `bootstrap failed: ${entry.error}` }];
  }
  const installed = (entry.installed as { marker?: unknown } | undefined)?.marker;
  if (installed === marker) return [];
  return [
    { kind: "bootstrapFailed", text: `bootstrap answered ${JSON.stringify(entry.installed)}` },
  ];
}

function attachReasons({ entry, marker, mode, script, stopped }: E3Sample): Reason[] {
  const reasons: Reason[] = [];
  if (stopped === false) {
    reasons.push({ kind: "notStopped", text: "the worker was still running before the load" });
  }
  if (!entry)
    return [...reasons, { kind: "notAttached", text: `Route A never attached ${script}` }];
  const pausing = mode === "pause";
  if (pausing) reasons.push(...pauseReasons(entry));
  // The bootstrap runs only at the pause, so a worker that never paused has nothing more to say.
  if (pausing && entry.waitingForDebugger && !entry.pause?.paused) return reasons;
  return [...reasons, ...bootstrapReasons(entry, marker)];
}

function effectReasons({ effects, marker, script }: E3Sample): Reason[] {
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
  // The worker's top level requests /me?from=<script>; without it the worker never started here.
  if (!effects.some((path) => fromOf(path) === script)) {
    reasons.push({ kind: "noEffect", text: `no top-level request from ${script}` });
  }
  return reasons;
}

function storeReasons(
  kind: string,
  names: string[] | { error: string },
  { marker, store, preexisting = [] }: E3Sample,
): Reason[] {
  if (!Array.isArray(names)) {
    return [{ kind: "storeUnreadable", text: `${kind} unreadable: ${names.error}` }];
  }
  const reasons: Reason[] = [];
  if (names.includes(store) && !preexisting.includes(store)) {
    reasons.push({
      kind: "firstEffectBeforeMarker",
      text: `${kind} holds ${store} without the prefix`,
    });
  }
  if (!names.includes(`${RESERVED_PREFIX}${marker}:${store}`)) {
    reasons.push({ kind: "noEffect", text: `${kind} has no ${store} under this marker` });
  }
  return reasons;
}

/** A sample passes when the bootstrap reached the worker first and every effect carries the marker. */
export function evaluateSample(sample: E3Sample): SampleOutcome {
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

function cachesMissingAtPause({ entry }: E3Sample): boolean {
  const seen = entry?.pause?.typeofAtPause as { caches?: unknown } | undefined;
  return seen?.caches === "undefined";
}

function countsOf(samples: E3Sample[], outcomes: SampleOutcome[]): Record<string, number> {
  const late = outcomes.map((outcome) => outcome.kinds.some((kind) => LATE.includes(kind)));
  const counts: Record<string, number> = {
    samples: samples.length,
    passed: outcomes.filter((outcome) => outcome.passed).length,
    lateAttaches: late.filter(Boolean).length,
  };
  for (const kind of KINDS) {
    counts[kind] = outcomes.filter((outcome) => outcome.kinds.includes(kind)).length;
  }
  // Counted beside the kinds: what the bootstrap answered and what the pause saw.
  counts.patchSkipped = samples.filter((sample) => skippedPatch(sample.entry)).length;
  counts.cachesMissingAtPause = samples.filter(cachesMissingAtPause).length;
  counts.installedLate = samples.filter(
    (sample, index) =>
      sample.entry?.installed !== undefined &&
      outcomes[index]?.kinds.includes("firstEffectBeforeMarker"),
  ).length;
  return counts;
}

function realmAgeOf({ entry }: E3Sample): number | undefined {
  return (entry?.installed as { realmAgeMs?: number } | undefined)?.realmAgeMs;
}

/** Named durations: the bootstrap measured from the attach (pause) or from the target's sighting. */
const DURATIONS: Record<string, (sample: E3Sample) => number | undefined> = {
  attachToBootstrapMs: (sample) =>
    sample.mode === "pause" ? sample.entry?.bootstrapMs : undefined,
  sightToBootstrapMs: (sample) => (sample.mode === "pause" ? undefined : sample.entry?.bootstrapMs),
  attachMs: (sample) => sample.entry?.attachMs,
  pausedMs: (sample) => sample.entry?.pause?.pausedMs,
  realmAgeMs: realmAgeOf,
  stopMs: (sample) => sample.stopMs,
};

function timingsOf(samples: E3Sample[]): Verdict["timings"] {
  const timings: NonNullable<Verdict["timings"]> = {};
  for (const [name, read] of Object.entries(DURATIONS)) {
    const values = samples
      .map(read)
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b);
    if (values.length === 0) continue;
    const max = percentile(values, 100);
    timings[name] = { p50: percentile(values, 50), p95: percentile(values, 95), max };
  }
  return Object.keys(timings).length > 0 ? timings : undefined;
}

function variantsOf(samples: E3Sample[], outcomes: SampleOutcome[]): Verdict["variants"] {
  const names = [...new Set(samples.map((sample) => sample.variant))];
  return names.map((name) => {
    const own = outcomes.filter((_, index) => samples[index]?.variant === name);
    const error = failureOf(own);
    const verdict: Verdict["verdict"] = error === undefined ? "pass" : "fail";
    return { name, verdict, ...(error === undefined ? {} : { error }), samples: own.length };
  });
}

function base(hypothesis: string, context: Context) {
  return {
    experiment: EXPERIMENT,
    hypothesis,
    chrome: context.browser.chrome,
    ...provenance(context.browser),
    condition: context.condition,
  };
}

/** The hypothesis passes only when every sample passed; otherwise the counts say how it failed. */
export function summarize(hypothesis: string, samples: E3Sample[], context: Context): Verdict {
  const outcomes = samples.map((sample) => evaluateSample(sample));
  const error = failureOf(outcomes);
  const counts = countsOf(samples, outcomes);
  const timings = timingsOf(samples);
  return {
    ...base(hypothesis, context),
    verdict: error === undefined ? "pass" : "fail",
    ...(error === undefined ? {} : { error }),
    samples: samples.length,
    lateAttaches: counts.lateAttaches ?? 0,
    counts,
    ...(timings ? { timings } : {}),
    variants: variantsOf(samples, outcomes),
  };
}

/** A hypothesis the fixture or the browser gave no way to test, with what the attempts saw. */
export function unavailable(
  hypothesis: string,
  error: string,
  context: Context,
  counts: Record<string, number> = {},
): Verdict {
  return {
    ...base(hypothesis, context),
    verdict: "unavailable",
    error,
    samples: counts.samples ?? 0,
    lateAttaches: counts.lateAttaches ?? 0,
    ...(Object.keys(counts).length > 0 ? { counts } : {}),
  };
}

type Status = "allowed" | "rejected";

/** A capabilities.json entry shaped like E1's, from the result of every time the command was sent. */
export interface Capability {
  description: string;
  status: Status | "unavailable";
  statuses: Status[];
  method: string;
  details: { result: string; count: number }[];
}

export function capabilityOf(description: string, results: string[], method: string): Capability {
  const counted = new Map<string, number>();
  for (const result of results) counted.set(result, (counted.get(result) ?? 0) + 1);
  const details = [...counted].map(([result, count]) => ({ result, count }));
  const statuses = [
    ...new Set(results.map((result): Status => (result === "ok" ? "allowed" : "rejected"))),
  ];
  const status =
    statuses.length === 0 ? "unavailable" : statuses.includes("rejected") ? "rejected" : "allowed";
  return { description, status, statuses, method, details };
}
