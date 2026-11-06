import { labEnvironment } from "../experiments/fixtures/e4-lab.ts";
import { matrix } from "../experiments/fixtures/clone-matrix.ts";
import { CLONE_CELLS, CLONE_EXPERIMENT } from "../experiments/fixtures/clones.ts";
import type { CloneHypothesis } from "../experiments/fixtures/clones.ts";
import { expectEveryHypothesis } from "../experiments/outcome.ts";
import { test } from "./fixtures/chrome.ts";
import { labClones } from "./fixtures/clone-rig.ts";

/*
 * POC PLAN.md P5.5 on Google Chrome Stable: a real base (poc-d0 loaded unpacked, templated and frozen
 * by base.sh) and a master on its own root; per round, clone.sh makes A and B and clone-open.sh opens
 * them, and the cells read what the roots, the diagnostics pages, and the background logs show.
 * Chrome is started by the scripts through a wrapper that opens a debugging port, so the lab can read
 * the clones; the host twin (tests/host/clones.spec.ts) runs the same cells on the owner's base.
 */

test.describe.configure({ mode: "serial", timeout: 1_800_000 });

test("the clone matrix: three roots, isolation, permissions, commands, reopen, and a later clone", async ({
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error("Set use.baseURL to the website preview.");
  const host = await labClones(testInfo, baseURL);
  try {
    const cells = matrix(host, labEnvironment.target);
    for (const cell of Object.keys(CLONE_CELLS) as CloneHypothesis[]) await cells.record(cell);
    await expectEveryHypothesis(CLONE_EXPERIMENT, Object.keys(CLONE_CELLS));
  } finally {
    await host.dispose();
  }
});
