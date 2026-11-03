import type { E1Browser } from "./e1-aggregate.ts";
import { isMarked, unmarked } from "./e2-samples.ts";
import { verdictOf } from "./e5-samples.ts";
import type { Names, Outcome, Reason } from "./e5-samples.ts";
import { nameOf } from "./e6-samples.ts";
import type { Verdict } from "./verdicts.ts";

// Pure part of E8 (tests/experiments/E8-strict.spec.ts), so Node unit tests reach it.
const EXPERIMENT = "E8";
/** Every E8 verdict's condition: Chrome without any remote debugging flag. */
export const CONDITION = "strict";
export const SW_SCRIPT = "/sw-main.js?variant=classic";
const SW_STORE = "fixture-sw";
/** What a reload answers when the page never loaded (tests/browser/fixtures/strict-steps.ts). */
const HELD = "held";

export const COLD_KINDS = [
  "notPaused",
  "noEffect",
  "firstEffectBeforeMarker",
  "databaseUnmarked",
  "cacheUnmarked",
  "storeUnreadable",
] as const;
export const RESTART_KINDS = [
  "held",
  "noReport",
  "noEffect",
  "firstEffectBeforeMarker",
  "databaseUnmarked",
] as const;
export const OTHER_KINDS = ["attachedBefore"] as const;

/** One cold registration on a tab the lab armed with `marker` and cleared. */
export interface ColdSample {
  marker: string;
  /** The worker's own requests (`/me?from=<script>`), in ledger order. */
  effects: string[];
  /** The database the worker reported on the page. */
  database: unknown;
  /** The origin's IndexedDB and Cache Storage names after the load. */
  databases: Names;
  caches: Names;
  /** Whether Route A held the worker at its instrumentation pause, from the posted journal. */
  paused: boolean | undefined;
}

function storeReason(kind: string, names: Names, expected: string): Reason | undefined {
  if (!Array.isArray(names)) return { kind: "storeUnreadable", text: `${kind}: ${names.error}` };
  if (names.includes(SW_STORE)) return { kind, text: `${kind} holds ${SW_STORE} unprefixed` };
  if (!names.includes(expected)) return { kind, text: `${kind} lacks the marked ${SW_STORE}` };
  return undefined;
}

/** A reload after the lab's closeTarget: what the page reported and the worker's own requests. */
export interface RestartSample {
  marker: string;
  /** The database the restarted worker reported, or `held` when the page never loaded. */
  restarted: unknown;
  /** The worker's own requests since the stop, in ledger order. */
  effects: string[];
}

function effectReasons({ effects, marker }: { effects: string[]; marker: string }): Reason[] {
  const [first] = effects;
  if (first === undefined) return [{ kind: "noEffect", text: `no request from ${SW_SCRIPT}` }];
  if (isMarked(first, marker)) return [];
  return [{ kind: "firstEffectBeforeMarker", text: `first request unmarked: ${unmarked(first)}` }];
}

/** A cold start passes when the worker paused and its first request and both stores carry the marker. */
export function evaluateCold(sample: ColdSample): Outcome {
  const expected = nameOf(sample.marker, SW_STORE);
  const reasons: Reason[] = [];
  if (sample.paused !== true) reasons.push({ kind: "notPaused", text: "no instrumentation pause" });
  reasons.push(...effectReasons(sample));
  if (sample.database !== expected) {
    const text = `the worker opened ${String(sample.database)}`;
    reasons.push({ kind: "databaseUnmarked", text: text.replace(sample.marker, "<marker>") });
  }
  for (const reason of [
    storeReason("databaseUnmarked", sample.databases, expected),
    storeReason("cacheUnmarked", sample.caches, expected),
  ]) {
    if (reason) reasons.push(reason);
  }
  return { variant: "sw-classic", reasons, tally: {}, waited: [] };
}

function loadReason(restarted: unknown): Reason | undefined {
  if (restarted === HELD) {
    const text = "the reload never loaded: the restarted worker waits on a debugger";
    return { kind: "held", text };
  }
  if (typeof restarted === "string") return undefined;
  return { kind: "noReport", text: `the page reported ${JSON.stringify(restarted)}` };
}

/** A reload after the lab's closeTarget passes when the restarted worker's first request and database carry the marker. */
export function evaluateRestart(sample: RestartSample): Outcome {
  const outcome = (reasons: Reason[], tally: Record<string, number>): Outcome => ({
    variant: "sw-classic",
    reasons,
    tally,
    waited: [],
  });
  const failed = loadReason(sample.restarted);
  if (failed) return outcome([failed], {});
  const expected = nameOf(sample.marker, SW_STORE);
  const reasons = effectReasons(sample);
  if (sample.restarted !== expected) {
    const text = `the restarted worker opened ${String(sample.restarted)}`;
    reasons.push({ kind: "databaseUnmarked", text: text.replace(sample.marker, "<marker>") });
  }
  const ran = sample.restarted === expected ? "marked" : String(sample.restarted);
  return outcome(reasons, { [`ran:${ran}`]: 1 });
}

/** The `Target.detachFromTarget` outcomes in the lab's stop results (Route A's `CloseReport.sessions`). */
export function childDetachesOf(stops: { result: unknown }[]): string[] {
  const reports = stops.flatMap(({ result }) =>
    Array.isArray(result) ? (result as unknown[]) : [],
  );
  return reports.flatMap((report) => {
    const { sessions } = (report ?? {}) as { sessions?: unknown };
    if (!Array.isArray(sessions)) return [];
    return sessions.map((session) => String((session as { detach?: unknown }).detach));
  });
}

/** Passes when no target was attached before the isolator armed anything: no other client exists. */
export function evaluateOthers(targets: { type: string; url: string; attached: boolean }[]) {
  const attached = targets.filter((target) => target.attached);
  const reasons = attached.map(({ type, url }) => ({
    kind: "attachedBefore",
    text: `${type} ${url} was attached before the isolator`,
  }));
  return { variant: "targets", reasons, tally: { targets: targets.length }, waited: [] };
}

/** E5's verdict over E8's outcomes, with E8's experiment and condition. */
export function e8Verdict(
  hypothesis: string,
  outcomes: Outcome[],
  browser: E1Browser,
  kinds: readonly string[],
): Verdict {
  const verdict = verdictOf(hypothesis, outcomes, browser, { kinds });
  return { ...verdict, experiment: EXPERIMENT, condition: CONDITION };
}
