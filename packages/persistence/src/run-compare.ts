import {
  APPLICATION_FAILURE_CODES,
  PROTOCOL_SCHEMA_VERSION,
  type DivergenceSide,
  type Event,
  type RunComparison,
  type RunDivergence,
  type StepResult,
} from "@recnrun/protocol";
import { journaledSteps } from "./interrupted-run.ts";
import type { StoredRun } from "./runs.ts";

type Outcome = Pick<StepResult, "status" | "error">;
type Finding = Omit<RunDivergence, "stepId" | "index">;
type GapEvent = Extract<Event, { category: "gap" }>;

const APPLICATION_CODES: ReadonlySet<string> = new Set(APPLICATION_FAILURE_CODES);
// Steps not yet settled on a side say nothing about how the runs differ.
const UNSETTLED: ReadonlySet<string> = new Set(["pending", "running"]);
const BEFORE_STEPS = "";

const outcomeOf = ({ status, error }: Outcome): Outcome => (error ? { status, error } : { status });

/** Each top-level step's outcome in run order: steps.json once the run ended, else the journal. */
function outcomes(run: StoredRun): Map<string, Outcome> {
  const result = new Map<string, Outcome>();
  if (run.steps) {
    for (const step of run.steps.steps)
      if (step.stepPath === undefined && !result.has(step.stepId))
        result.set(step.stepId, outcomeOf(step));
    return result;
  }
  const { started, finished } = journaledSteps(run.journal.events);
  for (const stepId of started.keys())
    result.set(stepId, outcomeOf(finished.get(stepId) ?? { status: "running" }));
  return result;
}

/** The journal split by step: an event without a step id belongs to the step that last started. */
function segments(events: readonly Event[]): Map<string, Event[]> {
  const byStep = new Map<string, Event[]>();
  let current = BEFORE_STEPS;
  for (const event of events) {
    if (event.type === "step.started" && event.stepId !== undefined) current = event.stepId;
    const key = event.stepId ?? current;
    const list = byStep.get(key) ?? [];
    list.push(event);
    byStep.set(key, list);
  }
  return byStep;
}

const gapOf = (event: Event): GapEvent | undefined =>
  event.category === "gap" ? event : undefined;

function responseOf(event: Event): { url: string; httpStatus: number } | undefined {
  if (event.category !== "network" || event.type !== "response") return undefined;
  const { url, status } = event.payload as Record<string, unknown>;
  return typeof url === "string" && typeof status === "number"
    ? { url, httpStatus: status }
    : undefined;
}

/** The events of `events` grouped by `key`, in journal order. */
function grouped(events: readonly Event[], key: (event: Event) => string | undefined) {
  const groups = new Map<string, Event[]>();
  for (const event of events) {
    const name = key(event);
    if (name !== undefined) groups.set(name, [...(groups.get(name) ?? []), event]);
  }
  return groups;
}

/** Counts each key as it is seen and answers how many times it was seen before. */
function occurrences() {
  const seen = new Map<string, number>();
  return (key: string) => {
    const before = seen.get(key) ?? 0;
    seen.set(key, before + 1);
    return before;
  };
}

function gapFinding(side: "baseline" | "run", event: GapEvent): Finding {
  const lost: DivergenceSide = { eventId: event.id, gap: event.payload };
  const who = side === "run" ? "This run" : "The baseline";
  return {
    kind: "collector-gap",
    reason: "collector-gap",
    message: `${who} lost events (${event.payload.reason}); what it did not record is unknown, not an application difference.`,
    baseline: side === "baseline" ? lost : {},
    run: side === "run" ? lost : {},
  };
}

function networkFinding(baseline: Event, run: Event): Finding | undefined {
  const theirs = responseOf(baseline);
  const ours = responseOf(run);
  if (!theirs || !ours || theirs.httpStatus === ours.httpStatus) return undefined;
  return {
    kind: "application",
    reason: "network-status",
    message: `${ours.url} answered ${ours.httpStatus} in this run and ${theirs.httpStatus} in the baseline.`,
    baseline: { ...theirs, eventId: baseline.id },
    run: { ...ours, eventId: run.id },
  };
}

/** The first event of `events` that is a gap `others` has no counterpart for. */
function unmatchedGap(events: readonly Event[], others: readonly Event[]): GapEvent | undefined {
  const theirs = grouped(others, (event) => gapOf(event)?.payload.reason);
  const nth = occurrences();
  return events.map(gapOf).find((gap) => {
    if (gap === undefined) return false;
    return theirs.get(gap.payload.reason)?.[nth(gap.payload.reason)] === undefined;
  });
}

/** A gap or a different response status in one step's events, in the run's order. */
function evidenceFinding(baseline: readonly Event[], run: readonly Event[]): Finding | undefined {
  const lostInRun = unmatchedGap(run, baseline);
  const responses = grouped(baseline, (event) => responseOf(event)?.url);
  const nth = occurrences();
  for (const event of run) {
    if (event === lostInRun) return gapFinding("run", event);
    const url = responseOf(event)?.url;
    const counterpart = url === undefined ? undefined : responses.get(url)?.[nth(url)];
    const found = counterpart && networkFinding(counterpart, event);
    if (found) return found;
  }
  const lostInBaseline = unmatchedGap(baseline, run);
  return lostInBaseline && gapFinding("baseline", lostInBaseline);
}

const sideOf = (outcome: Outcome | undefined): DivergenceSide =>
  outcome ? outcomeOf(outcome) : {};

/** Whom a failure code blames: an application failure, a failed assertion, or the replay itself. */
function blame(code: string | undefined): Pick<Finding, "kind" | "reason"> {
  if (code === "assertion-failed") return { kind: "application", reason: "assertion-failed" };
  const kind = code !== undefined && APPLICATION_CODES.has(code) ? "application" : "replay";
  return { kind, reason: "step-status" };
}

const statusText = (outcome: Outcome | undefined) => outcome?.status ?? "missing";

/** A step that ended differently; the side that did not pass says whom to blame. */
function statusFinding(
  stepId: string,
  baseline: Outcome | undefined,
  run: Outcome | undefined,
): Finding | undefined {
  if (baseline?.status === run?.status) return undefined;
  const failing = run && run.status !== "passed" ? run : baseline;
  const detail = failing?.error ? ` ${failing.error.message}` : "";
  return {
    ...blame(failing?.error?.code),
    message: `Step ${stepId} is ${statusText(run)} in this run and ${statusText(baseline)} in the baseline.${detail}`,
    baseline: sideOf(baseline),
    run: sideOf(run),
  };
}

interface Sides<T> {
  baseline: T;
  run: T;
}

function comparable(outcome: Sides<Outcome | undefined>, ended: boolean): boolean {
  const { baseline, run } = outcome;
  if (UNSETTLED.has(baseline?.status ?? "") || UNSETTLED.has(run?.status ?? "")) return false;
  // A step one side never reached only counts once both runs ended.
  return ended || (baseline !== undefined && run !== undefined);
}

function firstDivergence(
  runs: Sides<StoredRun>,
  order: readonly string[],
  steps: Sides<Map<string, Outcome>>,
): RunDivergence | undefined {
  const baseline = segments(runs.baseline.journal.events);
  const run = segments(runs.run.journal.events);
  const segment = (stepId: string) => [baseline.get(stepId) ?? [], run.get(stepId) ?? []] as const;
  const before = evidenceFinding(...segment(BEFORE_STEPS));
  if (before) return before;
  const ended = runs.baseline.summary !== undefined && runs.run.summary !== undefined;
  for (const [index, stepId] of order.entries()) {
    const outcome = { baseline: steps.baseline.get(stepId), run: steps.run.get(stepId) };
    const found =
      evidenceFinding(...segment(stepId)) ??
      (comparable(outcome, ended)
        ? statusFinding(stepId, outcome.baseline, outcome.run)
        : undefined);
    if (found) return { ...found, stepId, index };
  }
  return undefined;
}

/**
 * Aligns two runs of one flow step by step and names their first observable divergence.
 * A step's events come before its status, since what the page did explains how it ended.
 */
export function compareRuns(baseline: StoredRun, run: StoredRun): RunComparison {
  const steps = { baseline: outcomes(baseline), run: outcomes(run) };
  const order = [...new Set([...steps.run.keys(), ...steps.baseline.keys()])];
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    baselineRunId: baseline.manifest.runId,
    runId: run.manifest.runId,
    flowId: run.manifest.flowId,
    sameRevision: baseline.manifest.flowRevision === run.manifest.flowRevision,
    steps: order.map((stepId, index) => {
      const [before, now] = [steps.baseline.get(stepId), steps.run.get(stepId)];
      return {
        stepId,
        index,
        ...(before && { baseline: before.status }),
        ...(now && { run: now.status }),
      };
    }),
    divergence: firstDivergence({ baseline, run }, order, steps) ?? null,
  };
}
