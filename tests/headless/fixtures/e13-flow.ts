import { commandsSample, navigationSample } from "./e13-remote.ts";
import { alternateSample, backgroundSample } from "./e13-lifecycle.ts";
import { workersSample } from "./e13-cells.ts";
import type { recorderOf } from "./e13-cells.ts";
import type { Lab } from "./e13-lab.ts";

/*
 * The cells of E13 over hand-installed workers, in one place for the lab spec (Docker) and its host
 * twin (the Mac): the same samples, the same topologies, a recorder that says where they land.
 */

export type Recorder = ReturnType<typeof recorderOf>;

const v1Topology = (count: number) =>
  `${count} hand-installed workers, one root each, opened by open.sh headless`;

const NO_WINDOW =
  "not applicable: headless has no window to focus and no picture-in-picture surface";

/** t6, ops.navigation, t7, focus, pip over `lab.workers`, all opened headless. */
export async function workerCells(lab: Lab, { record, unavailable }: Recorder) {
  const topology = v1Topology(lab.workers.length);
  await record("t6.workers", topology, () => workersSample(lab));
  await record(
    "t6.commands",
    `${topology}; each worker is bound to the master, which opens the test page in it and activates the tab it reports`,
    () => commandsSample(lab, lab.workers),
  );
  await record(
    "ops.navigation",
    `${topology}; the master opens the start page, which navigates itself to the marker page`,
    () => navigationSample(lab, lab.workers),
  );
  await record("t7.background", `${topology}; the master has no page open`, () =>
    backgroundSample(lab),
  );
  await unavailable("focus", topology, NO_WINDOW);
  await unavailable("pip", topology, NO_WINDOW);
}

/** t8.alternate over the one worker of `lab`. */
export async function alternateCell(lab: Lab, { record }: Recorder) {
  await record(
    "t8.alternate",
    "one hand-installed worker root opened headed, headless, headed",
    () => alternateSample(lab),
  );
}
