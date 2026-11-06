import { matrix } from "../experiments/fixtures/clone-matrix.ts";
import { CLONE_CELLS, CLONE_EXPERIMENT } from "../experiments/fixtures/clones.ts";
import type { CloneHypothesis } from "../experiments/fixtures/clones.ts";
import { expectEveryHypothesis } from "../experiments/outcome.ts";
import { hostEnvironment } from "./fixtures/e4-host.ts";
import { hostClones } from "./fixtures/clones-host.ts";
import { evidence } from "./fixtures/host-env.ts";
import { test } from "./fixtures/host-chrome.ts";

/*
 * P5.5's host twin: the clone matrix on the installed Google Chrome of this Mac, over the owner's
 * frozen base and the record of the owner's personal Default as master (RECNRUN_HOST_BASES,
 * RECNRUN_HOST_RECORD). The master is never launched, killed, read, or copied, so its side of each
 * cell is read from the clones: their pins of it, their logs, their refusals. Master-issued commands
 * cannot be sent from here; the lab spec covers them. Clones live under `<bases>/clones/<run id>/`
 * and are removed at the end; the record keeps the worker blocks they appended (see the CHECKLIST).
 */

test.describe.configure({ mode: "serial", timeout: 1_800_000 });

test("the clone matrix on the owner's base: three roots, isolation, permissions, commands, reopen, a later clone", async () => {
  const host = await hostClones();
  try {
    const cells = matrix(host, hostEnvironment.target);
    for (const cell of Object.keys(CLONE_CELLS) as CloneHypothesis[]) await cells.record(cell);
  } finally {
    await host.dispose();
  }
});

test("every P5.5 clone hypothesis left a verdict", async () => {
  await expectEveryHypothesis(CLONE_EXPERIMENT, Object.keys(CLONE_CELLS), evidence().directory);
});
