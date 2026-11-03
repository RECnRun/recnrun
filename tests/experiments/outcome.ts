import { expect } from "@playwright/test";
import { UnavailableError } from "../browser/fixtures/policy-install.ts";
import { sized } from "./samples.ts";
import { appendVerdict, readVerdicts } from "./verdicts.ts";
import type { Verdict } from "./verdicts.ts";

/** One sample of a hypothesis: its result, what it saw, and the gestures it needed. */
export interface Sample {
  ok: boolean;
  error?: string;
  observation: Record<string, unknown>;
  steps?: string[];
}

/** Everything a verdict states about the cell, as opposed to what its samples found. */
export type Cell = Pick<
  Verdict,
  | "experiment"
  | "hypothesis"
  | "chrome"
  | "environment"
  | "install"
  | "label"
  | "externalClient"
  | "variant"
  | "topology"
  | "debugger"
>;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function takeSamples(take: () => Promise<Sample>, count: number) {
  const samples: Sample[] = [];
  for (let index = count; index > 0; index--) {
    try {
      samples.push(await take());
    } catch (error) {
      if (error instanceof UnavailableError) return { samples, unavailable: error.message };
      samples.push({ ok: false, error: message(error), observation: {} });
    }
  }
  return { samples, unavailable: undefined };
}

// Distributes over the verdict variants, so each keeps its own error and sample rules.
type Outcome<V extends Verdict = Verdict> = V extends unknown
  ? Pick<V, "verdict" | "error" | "samples">
  : never;

/** `unavailable` only when the method could not run at all; it names the reason with no sample. */
function outcome(samples: Sample[], unavailable: string | undefined): Outcome {
  if (unavailable && samples.length === 0) {
    return { verdict: "unavailable", error: unavailable, samples: 0 };
  }
  const errors = samples.flatMap((sample) => (sample.error ? [sample.error] : []));
  const passed = samples.length > 0 && samples.every((sample) => sample.ok);
  const error = unavailable ?? (errors.length > 0 ? errors.join(" | ") : undefined);
  const verdict = passed ? "pass" : "fail";
  return { verdict, ...(error === undefined ? {} : { error }), samples: samples.length };
}

/** The gestures of the sample that needed the most; each observation keeps its own. */
function gestures(samples: Sample[]): { gestures: number; steps: string[] } {
  const steps = samples
    .map((sample) => sample.steps ?? [])
    .reduce<string[]>((most, next) => (next.length > most.length ? next : most), []);
  return { gestures: steps.length, steps };
}

/**
 * Takes `sized(full)` samples (one in smoke mode), writes the verdict to `directory` (the run's
 * lab folder by default), and prints it.
 */
export async function recordHypothesis(
  cell: Cell,
  take: () => Promise<Sample>,
  { full = 3, directory }: { full?: number; directory?: string } = {},
): Promise<Verdict> {
  const { samples, unavailable } = await takeSamples(take, sized(full));
  const verdict: Verdict = {
    ...cell,
    ...outcome(samples, unavailable),
    ...gestures(samples),
    observations: samples.map((sample) => sample.observation),
  };
  await appendVerdict(verdict, directory);
  console.log(JSON.stringify(verdict));
  return verdict;
}

/** Records a hypothesis that cannot run in this cell, naming why, with no sample. */
export const recordUnavailable = (cell: Cell, reason: string, directory?: string) =>
  recordHypothesis(
    cell,
    () => Promise.reject(new UnavailableError(reason)),
    directory === undefined ? {} : { directory },
  );

/** Fails only when a hypothesis of `experiment` left no verdict, or one with no sample and no reason. */
export async function expectEveryHypothesis(
  experiment: string,
  hypotheses: readonly string[],
  directory?: string,
): Promise<void> {
  const verdicts = (await readVerdicts(directory)).filter(
    (entry) => entry.experiment === experiment,
  );
  const latest = new Map(verdicts.map((entry) => [entry.hypothesis, entry]));
  expect([...latest.keys()].sort(), "every hypothesis ran").toEqual([...hypotheses].sort());
  for (const verdict of latest.values()) {
    const sampled = verdict.samples > 0 || (verdict.verdict === "unavailable" && verdict.error);
    expect(sampled, `${verdict.hypothesis} took no sample`).toBeTruthy();
  }
}
