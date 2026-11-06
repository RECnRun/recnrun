import { recordHypothesis } from "../outcome.ts";
import type { Cell, Sample } from "../outcome.ts";
import type { Verdict } from "../verdicts.ts";

export type { Sample };

/** Where E2 ran and where its verdicts go (the lab's evidence folder, or the host's). */
export interface VerdictTarget {
  environment: "lab" | "host";
  chrome: () => Promise<string>;
  /** The verdicts folder: the lab run's when absent, the host's `evidence().directory`. */
  directory?: () => string;
}

/** Records one E2 verdict through outcome.ts: D0, one root, installed over CDP, `sized(3)` samples. */
export async function recordE2(
  hypothesis: string,
  target: VerdictTarget,
  take: () => Promise<Sample>,
): Promise<Verdict> {
  const cell: Cell = {
    experiment: "E2",
    hypothesis,
    chrome: await target.chrome(),
    environment: target.environment,
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology: "single",
    debugger: "none",
  };
  const directory = target.directory?.();
  return recordHypothesis(cell, take, directory === undefined ? {} : { directory });
}

/** A sample from a list of problems: it held when there were none; `steps` are its gestures. */
export function judged(
  problems: string[],
  observation: Record<string, unknown>,
  steps: string[] = [],
): Sample {
  if (problems.length === 0) return { ok: true, observation, steps };
  return { ok: false, error: problems.join("; "), observation, steps };
}
