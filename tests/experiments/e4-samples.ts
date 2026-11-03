import { provenance } from "./e1-aggregate.ts";
import type { E1Browser } from "./e1-aggregate.ts";
import type { Verdict } from "./verdicts.ts";

// Pure part of E4 (tests/experiments/E4-stop-restart.spec.ts), so Node unit tests reach it.
const EXPERIMENT = "E4";
// packages/isolation-core/src/marker.ts restated, so the harness checks the bootstrap's effect on its own.
const MARKER_PARAM = "__rec";
const API = "http://api.localhost:4601";

export type Mechanism =
  | "close-target"
  | "terminate-execution"
  | "debugger-pause"
  | "dnr-block-evict"
  | "unregister";

export type Trigger = "navigation" | "post-message" | "sync" | "none";

/** How the extension saw the worker that started after the trigger, before its first statement. */
export interface RestartEntry {
  /** Route A's auto-attach of a new target, or the restart watch on a session kept across the stop. */
  observedBy: "auto-attach" | "reload-watch";
  /** Absent for the restart watch, which Chrome does not tell whether the worker waits. */
  waitingForDebugger?: boolean;
  installed?: unknown;
  released: boolean;
  error?: string;
}

/** One stop and one restart trigger on one freshly registered service worker. */
export interface E4Sample {
  mechanism: Mechanism;
  /** The script variant, or how the mechanism was applied (`tab-session`, `held`, `held-module`). */
  variant: string;
  trigger: Trigger;
  marker: string;
  /** The marker the extension armed for the restart. */
  restartMarker: string;
  /** The worker script, path and query, as its `location.pathname + location.search`. */
  script: string;
  /** Chrome's exact error when it refused the stop command. */
  stopError?: string;
  /** Whether `Debugger.paused` arrived (`debugger-pause` only). */
  paused?: boolean;
  /** The stop command's duration in the isolator. */
  stopCommandMs?: number;
  /** From the stop command to Chrome no longer listing the target; `null` when it still did at the bound. */
  unlistedMs: number | null;
  /** Ledger paths of the worker's requests from the stop command to the trigger. */
  beforeTrigger: string[];
  /** Ledger paths of the worker's requests after the trigger (while held, for `debugger-pause`). */
  afterTrigger: string[];
  /** From the trigger to the first request of a fresh start of the script. */
  restartMs?: number;
  restart?: RestartEntry;
  /** Whether the origin still had a registration after the trigger; `null` when it could not be read. */
  registrationKept: boolean | null;
  /** Whether Cache Storage still held the precache `fixture-shell-v1`; `null` when unreadable. */
  precacheKept: boolean | null;
  /** Ledger paths of the worker script fetched after the stop (update checks). */
  scriptFetches: string[];
  /** Whether a navigation under the scope finished while the worker was held (`debugger-pause`). */
  navigationFinished?: boolean;
}

export interface SampleOutcome {
  passed: boolean;
  stopped: boolean;
  restartedUnsolicited: boolean;
  restarted: boolean;
  observed: boolean;
  reasons: string[];
}

function searchOf(path: string): URLSearchParams {
  return new URL(path, API).searchParams;
}

/** A request the script makes as its first statement, so only a fresh start of it makes one. */
function isStart(path: string, script: string): boolean {
  return path.startsWith("/me?") && searchOf(path).get("from") === script;
}

function stoppedOf(sample: E4Sample): boolean {
  if (sample.stopError !== undefined) return false;
  if (sample.mechanism !== "debugger-pause") return sample.unlistedMs !== null;
  return sample.paused === true && [...sample.beforeTrigger, ...sample.afterTrigger].length === 0;
}

function stopReasons(sample: E4Sample, stopped: boolean): string[] {
  if (sample.stopError !== undefined) return [`stop refused: ${sample.stopError}`];
  if (stopped) return [];
  if (sample.mechanism !== "debugger-pause") return ["the target stayed listed"];
  return [sample.paused ? "the worker made requests while held" : "Debugger.paused never came"];
}

function restartReasons(sample: E4Sample, first: string): string[] {
  const { restart, restartMarker } = sample;
  const reasons: string[] = [];
  if (searchOf(first).get(MARKER_PARAM) !== restartMarker) {
    reasons.push("the restarted worker's first request lacks the restart marker");
  }
  if (!restart) return [...reasons, "the extension never saw the restart"];
  const installed = (restart.installed as { marker?: unknown } | undefined)?.marker;
  if (restart.waitingForDebugger === false) reasons.push("the restart attached while running");
  if (restart.error !== undefined) reasons.push(`restart bootstrap failed: ${restart.error}`);
  else if (installed !== restartMarker) reasons.push("restart bootstrap without the marker");
  if (!restart.released) reasons.push("the restarted worker was never released");
  return reasons;
}

/** A sample passes when the worker stopped, nothing restarted it unasked, and any restart was seen first. */
export function evaluateSample(sample: E4Sample): SampleOutcome {
  const stopped = stoppedOf(sample);
  const restartedUnsolicited = sample.beforeTrigger.some((path) => isStart(path, sample.script));
  const first = sample.afterTrigger.find((path) => isStart(path, sample.script));
  const restarted = first !== undefined && sample.mechanism !== "debugger-pause";
  const missed = restarted ? restartReasons(sample, first) : [];
  const reasons = [
    ...stopReasons(sample, stopped),
    ...(restartedUnsolicited ? ["the worker started again before the trigger"] : []),
    ...missed,
  ];
  return {
    passed: reasons.length === 0,
    stopped,
    restartedUnsolicited,
    restarted,
    observed: restarted && missed.length === 0,
    reasons,
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

function countsOf(samples: E4Sample[], outcomes: SampleOutcome[]): Record<string, number> {
  const count = (test: (outcome: SampleOutcome) => boolean) => outcomes.filter(test).length;
  const where = (test: (sample: E4Sample) => boolean) => samples.filter(test).length;
  return {
    samples: samples.length,
    stops: count((outcome) => outcome.stopped),
    restartsUnsolicited: count((outcome) => outcome.restartedUnsolicited),
    restarts: count((outcome) => outcome.restarted),
    restartObservedBeforeFirstStatement: count((outcome) => outcome.observed),
    registrationKept: where((sample) => sample.registrationKept === true),
    precacheKept: where((sample) => sample.precacheKept === true),
    scriptFetchedAfterStop: where((sample) => sample.scriptFetches.length > 0),
    navigationsHeld: where((sample) => sample.navigationFinished === false),
  };
}

/** Nearest-rank percentile of ascending `sorted`, to a tenth of a millisecond. */
function percentile(sorted: number[], p: number): number {
  const value = sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  return Math.round(value * 10) / 10;
}

function spread(values: (number | null | undefined)[]) {
  const sorted = values.filter((value): value is number => typeof value === "number");
  sorted.sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: percentile(sorted, 100) };
}

function timingsOf(samples: E4Sample[]): Verdict["timings"] {
  const timings: NonNullable<Verdict["timings"]> = {};
  const named = {
    stopCommandMs: samples.map((sample) => sample.stopCommandMs),
    unlistedMs: samples.map((sample) => sample.unlistedMs),
    restartMs: samples.map((sample) => sample.restartMs),
  };
  for (const [name, values] of Object.entries(named)) {
    const timing = spread(values);
    if (timing) timings[name] = timing;
  }
  return Object.keys(timings).length > 0 ? timings : undefined;
}

function variantsOf(samples: E4Sample[], outcomes: SampleOutcome[]): Verdict["variants"] {
  const nameOf = (sample: E4Sample) => `${sample.variant}/${sample.trigger}`;
  const names = [...new Set(samples.map(nameOf))];
  return names.map((name) => {
    const own = outcomes.filter((_, index) => {
      const sample = samples[index];
      return sample !== undefined && nameOf(sample) === name;
    });
    const error = failureOf(own);
    const verdict: Verdict["verdict"] = error === undefined ? "pass" : "fail";
    return { name, verdict, ...(error === undefined ? {} : { error }), samples: own.length };
  });
}

/** The mechanism passes only when every sample passed; the counts say what each sample showed. */
export function summarize(mechanism: Mechanism, samples: E4Sample[], browser: E1Browser): Verdict {
  const outcomes = samples.map((sample) => evaluateSample(sample));
  const error = failureOf(outcomes);
  const timings = timingsOf(samples);
  return {
    experiment: EXPERIMENT,
    hypothesis: mechanism,
    verdict: error === undefined ? "pass" : "fail",
    ...(error === undefined ? {} : { error }),
    chrome: browser.chrome,
    samples: samples.length,
    ...provenance(browser),
    counts: countsOf(samples, outcomes),
    ...(timings ? { timings } : {}),
    variants: variantsOf(samples, outcomes),
  };
}
