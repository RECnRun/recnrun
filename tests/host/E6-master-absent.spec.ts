import { extensionPath } from "../browser/fixtures/extension-loaders.ts";
import { E6_RUNS } from "../experiments/e6-runs.ts";
import { HOST_CELLS, recordE6 } from "../experiments/e6-samples.ts";
import { requireBuild } from "../experiments/file-access.ts";
import { expectEveryHypothesis } from "../experiments/outcome.ts";
import { hostE5 } from "./fixtures/e5-host.ts";
import { test } from "./fixtures/host-chrome.ts";
import { evidence } from "./fixtures/host-env.ts";

/*
 * E6's host twin (POC PLAN.md P3.5): the cells §7.4 runs on the host, on the installed Google
 * Chrome of this Mac and throwaway roots only; the forged sender's files stay a lab cell.
 */

test.describe("E6 on the host: master absent and master back", () => {
  // Three round trips of three launches and a 75 s absence, slower than the lab's.
  test.describe.configure({ timeout: 1_800_000 });

  test.beforeAll(async () => {
    await requireBuild(extensionPath("poc-d0"), "poc-d0");
  });

  for (const hypothesis of HOST_CELLS) {
    const run = E6_RUNS[hypothesis];
    test(`${hypothesis}: ${run.title}`, async () => {
      await recordE6(hypothesis, hostE5.target, () => run.sample(hostE5));
    });
  }

  test("every E6 host hypothesis left a verdict", async () => {
    await expectEveryHypothesis("E6", HOST_CELLS, evidence().directory);
  });
});
