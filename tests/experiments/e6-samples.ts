import type { E1Browser } from "./e1-aggregate.ts";
import { verdictOf } from "./e5-samples.ts";
import type { Names, Outcome, Reason, RouteBJournal } from "./e5-samples.ts";
import type { Verdict } from "./verdicts.ts";

// Pure part of E6 (tests/experiments/E6-route-b-selection.spec.ts), so Node unit tests reach it.
const EXPERIMENT = "E6";
// packages/isolation-core/src/marker.ts restated, so the harness checks the bootstrap's effect on its own.
const RESERVED_PREFIX = "__rec:";

export const SWITCH_KINDS = [
  "firstNotSelected",
  "notRestarted",
  "unmarked",
  "stale",
  "noStore",
  "notObserved",
  "storeUnreadable",
  "notSuspended",
  "rulesLost",
  "stalled",
] as const;

/** A worker started under slot `before`, the selection switched to `after`, and a worker started again. */
export interface SwitchSample {
  realm: "service" | "dedicated" | "shared";
  selection: string;
  /** Whether the switch was sent before the first worker activated (`early`) or after (`late`). */
  timing: "early" | "late";
  before: string;
  after: string;
  store: string;
  /** IndexedDB names after the first start, and after the start that followed the switch. */
  first: Names;
  second: Names;
  /** Whether a worker ran after the switch: a service-worker target came back, or the page reported. */
  started: boolean;
  /** Markers on the requests the worker made after the switch, read from the ledger (service workers). */
  running?: string[];
  /** What the page reported when the first start failed, for example a refused registration. */
  error?: string;
  /** Milliseconds `updateSessionRules` took for the switch. */
  switchMs: number;
  /** Whether the switch resolved before the first worker's install ended (early switches only). */
  beforeActivated?: boolean;
  /** Whether no version was installing or waiting before the restart, so a soft update had ended. */
  settled?: boolean;
  /** How many times Chrome fetched the script before the restart; more than once is a soft update. */
  scriptFetches?: number;
  /** Whether the navigation that restarts the worker had not committed when the harness gave up. */
  stalled?: boolean;
  /** Milliseconds from that navigation until it committed or the harness gave up. */
  restartMs?: number;
  /** Route B's journal of the start after the switch. */
  journal?: RouteBJournal;
}

export const nameOf = (marker: string, store: string) => `${RESERVED_PREFIX}${marker}:${store}`;

function namesText(names: Names): string {
  return Array.isArray(names) ? `[${names.join(", ")}]` : names.error;
}

function has(names: Names, name: string): boolean {
  return Array.isArray(names) && names.includes(name);
}

function firstReason(sample: SwitchSample): Reason | undefined {
  if (!Array.isArray(sample.first)) return { kind: "storeUnreadable", text: sample.first.error };
  const markers = [sample.before, sample.after];
  if (markers.some((marker) => has(sample.first, nameOf(marker, sample.store)))) return undefined;
  const error = sample.error === undefined ? "" : `: ${sample.error}`;
  return {
    kind: "firstNotSelected",
    text: `first start opened ${namesText(sample.first)}${error}`,
  };
}

/** Why the start after the switch did not run as the new slot, or `undefined` when it did. */
function secondReason(sample: SwitchSample): Reason | undefined {
  const { second, before, after } = sample;
  const running = sample.running ?? [];
  if (!Array.isArray(second)) return { kind: "storeUnreadable", text: second.error };
  const opened = `after the switch to ${after}: ${namesText(second)}`;
  // The worker's own requests outrank the stores, which a later unmarked version can add to.
  if (running.includes(before) && !running.includes(after))
    return { kind: "stale", text: `ran as ${before} ${opened}` };
  if (running.includes(after)) return undefined;
  return startReason(sample, opened) ?? storeReason(sample, opened);
}

function startReason(sample: SwitchSample, opened: string): Reason | undefined {
  if (sample.stalled === true) return stalledReason(sample);
  if (!sample.started) return { kind: "notRestarted", text: "no worker started after the switch" };
  if (has(sample.second, sample.store))
    return { kind: "unmarked", text: `unprefixed ${sample.store} ${opened}` };
  return undefined;
}

/** With no request naming a slot, the new slot's database proves the start only if it was not there before. */
function storeReason(sample: SwitchSample, opened: string): Reason | undefined {
  const { second, store, before, after } = sample;
  const target = nameOf(after, store);
  if (has(second, target)) {
    if (!has(sample.first, target)) return undefined;
    const text = `the first start had already opened ${target}; no request carried ${after} ${opened}`;
    return { kind: "notObserved", text };
  }
  if (has(second, nameOf(before, store))) return { kind: "stale", text: `stale ${opened}` };
  return { kind: "noStore", text: `no ${store} database ${opened}` };
}

function stalledReason(sample: SwitchSample): Reason {
  const after = sample.restartMs === undefined ? "" : ` after ${sample.restartMs} ms`;
  return {
    kind: "stalled",
    text: `the navigation that restarts the worker had not committed${after}`,
  };
}

function tallyOf(sample: SwitchSample, reasons: Reason[]): Record<string, number> {
  const tally: Record<string, number> = { [reasons.length === 0 ? "fresh" : "notFresh"]: 1 };
  if (has(sample.second, sample.store)) tally.unprefixedAfter = 1;
  if (has(sample.first, nameOf(sample.after, sample.store))) tally.firstTookAfter = 1;
  if (sample.beforeActivated === true) tally.switchedBeforeActivated = 1;
  return { ...tally, ...updateTally(sample) };
}

/** Soft updates Chrome ran before the restart, which install the script without the wrapper. */
function updateTally(sample: SwitchSample): Record<string, number> {
  const tally: Record<string, number> = {};
  if ((sample.scriptFetches ?? 0) > 1) tally.softUpdated = 1;
  if (sample.settled === false) tally.unsettled = 1;
  return tally;
}

const variantOf = (sample: SwitchSample) => `${sample.realm}:${sample.selection}`;

/** The start after a switch passes when it opened the database of the slot switched to. */
export function evaluateSwitch(sample: SwitchSample): Outcome {
  const reason = firstReason(sample) ?? secondReason(sample);
  const reasons = reason === undefined ? [] : [reason];
  return { variant: variantOf(sample), reasons, tally: tallyOf(sample, reasons), waited: [] };
}

function keptReason(sample: SwitchSample): Reason | undefined {
  const running = sample.running ?? [];
  if (running.includes(sample.before)) return undefined;
  if (sample.stalled === true) return stalledReason(sample);
  if (!sample.started && running.length === 0) {
    return { kind: "notRestarted", text: "no worker started again" };
  }
  if (has(sample.second, sample.store)) {
    return { kind: "unmarked", text: `unprefixed ${sample.store}: ${namesText(sample.second)}` };
  }
  const ran = running.length === 0 ? "no request carried a marker" : `ran as ${running.join(", ")}`;
  return { kind: "notObserved", text: `the worker started again but ${ran}` };
}

/** A restart that must keep the slot the worker was installed with, which its own requests name. */
export function evaluateKept(sample: SwitchSample): Outcome {
  const reason = firstReason(sample) ?? keptReason(sample);
  const reasons = reason === undefined ? [] : [reason];
  const tally = { [reason === undefined ? "kept" : "notKept"]: 1, ...updateTally(sample) };
  for (const marker of sample.running ?? []) tally[`ran:${marker}`] = 1;
  return { variant: variantOf(sample), reasons, tally, waited: [] };
}

/** What the isolator's selection status said before and after its background closed itself. */
export interface Suspension {
  suspended: boolean;
  resumed: boolean;
  before: { ruleIds: number[] };
  after: { ruleIds: number[]; suspend: { attach?: string; close?: string } | null };
  /** Why `suspend()` threw. */
  error?: string;
}

/** Chrome's own words for a suspension that did not happen, when it gave any. */
function suspensionError(suspension: Suspension): string | undefined {
  const { attach, close } = suspension.after.suspend ?? {};
  if (suspension.error !== undefined) return suspension.error;
  if (attach !== undefined && attach !== "ok") return `attach to its own target: ${attach}`;
  return close === undefined ? undefined : `Target.closeTarget on itself: ${close}`;
}

/** A start's outcome, failed too when the background did not stop and start again or lost its rules. */
export function suspendedOutcome(outcome: Outcome, suspension: Suspension): Outcome {
  const reasons = [...outcome.reasons];
  if (!suspension.suspended || !suspension.resumed) {
    const fallback = `suspended ${suspension.suspended}, resumed ${suspension.resumed}`;
    reasons.push({ kind: "notSuspended", text: suspensionError(suspension) ?? fallback });
  }
  const kept = suspension.before.ruleIds.every((id) => suspension.after.ruleIds.includes(id));
  if (!kept)
    reasons.push({ kind: "rulesLost", text: "the session rules were gone after the resume" });
  const tally = { ...outcome.tally, suspended: Number(suspension.suspended) };
  return { ...outcome, reasons, tally: { ...tally, resumed: Number(suspension.resumed) } };
}

export interface E6Context {
  browser: E1Browser;
  /** `RECNRUN_STRESS_CONDITION` of scripts/test-stress.mjs, or `baseline`. */
  condition: string;
  label?: Verdict["label"];
}

/** Nearest-rank percentiles of `values`, to a tenth of a millisecond. */
export function percentiles(values: number[]): { p50: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  const round = (value: number) => Math.round(value * 10) / 10;
  return { p50: round(at(50)), p95: round(at(95)), max: round(at(100)) };
}

/** E5's verdict over E6's outcomes, with the condition, the switch timings, and stale starts as late attaches. */
export function e6Verdict(
  hypothesis: string,
  outcomes: Outcome[],
  switchMs: number[],
  context: E6Context,
): Verdict {
  const options = { kinds: SWITCH_KINDS, ...(context.label ? { label: context.label } : {}) };
  const verdict = verdictOf(hypothesis, outcomes, context.browser, options);
  const stale = outcomes.filter((o) => o.reasons.some((r) => r.kind === "stale")).length;
  return {
    ...verdict,
    experiment: EXPERIMENT,
    condition: context.condition,
    lateAttaches: stale,
    ...(switchMs.length > 0 ? { timings: { switchMs: percentiles(switchMs) } } : {}),
  };
}

/** Adds how long the restarts' navigations took, which a soft update's waiting version can hold. */
export function withRestarts(verdict: Verdict, samples: SwitchSample[]): Verdict {
  const values = samples.flatMap((sample) =>
    sample.restartMs === undefined ? [] : [sample.restartMs],
  );
  if (values.length === 0) return verdict;
  return { ...verdict, timings: { ...verdict.timings, restartMs: percentiles(values) } };
}

/** A hypothesis the run could not reach, with Chrome's exact error. */
export function unavailableVerdict(hypothesis: string, error: string, context: E6Context): Verdict {
  return {
    experiment: EXPERIMENT,
    hypothesis,
    verdict: "unavailable",
    error,
    chrome: context.browser.chrome,
    method: context.browser.method,
    ...(context.label ? { label: context.label } : {}),
    samples: 0,
    condition: context.condition,
  };
}
