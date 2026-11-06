import type { Sample, VerdictTarget } from "./fixtures/downloads-verdicts.ts";
import { recordHypothesis } from "./outcome.ts";
import type { Cell } from "./outcome.ts";

/*
 * The cells of E6 (POC PLAN.md P3.5), shared by the lab spec and its host twin: E6.a while the
 * master is closed, E6.b once the same Default is back on its root, E6.c a worker restart instead.
 */

const HIERARCHY = "Default bound as master of two workers, one shared Downloads root";
const FORGED =
  "Default bound as master of two workers and a virtual peer the test writes under the Default's id, one shared Downloads root";
const THIRD =
  "Default bound as master of two workers and a third profile that claims to be master, one shared Downloads root";

/** Each cell and its topology. */
export const E6_CELLS = {
  "E6.a.absent": HIERARCHY,
  "E6.a.forgedMaster": FORGED,
  "E6.a.thirdMaster": THIRD,
  "E6.b.relink": HIERARCHY,
  "E6.b.status": HIERARCHY,
  "E6.b.results": HIERARCHY,
  "E6.c.workerRestart": HIERARCHY,
} as const;
export type E6Hypothesis = keyof typeof E6_CELLS;

/** §7.4 of the plan keeps a forged sender's files to the lab; a clone forging master runs on both. */
const LAB_ONLY: readonly E6Hypothesis[] = ["E6.a.forgedMaster"];
export const HOST_CELLS = (Object.keys(E6_CELLS) as E6Hypothesis[]).filter(
  (each) => !LAB_ONLY.includes(each),
);

async function e6Cell(hypothesis: E6Hypothesis, target: VerdictTarget): Promise<Cell> {
  return {
    experiment: "E6",
    hypothesis,
    chrome: await target.chrome(),
    environment: target.environment,
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology: E6_CELLS[hypothesis],
    debugger: "none",
  };
}

/** Records one E6 verdict through outcome.ts: `full` samples (one in smoke mode). */
export async function recordE6(
  hypothesis: E6Hypothesis,
  target: VerdictTarget,
  take: () => Promise<Sample>,
  full = 3,
) {
  const directory = target.directory?.();
  const options = directory === undefined ? { full } : { full, directory };
  return recordHypothesis(await e6Cell(hypothesis, target), take, options);
}
