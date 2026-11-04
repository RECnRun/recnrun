import { extensionPath } from "../browser/fixtures/extension-loaders.ts";
import { E5_RUNS } from "../experiments/e5-runs.ts";
import { HOST_CELLS, recordE5 } from "../experiments/e5-samples.ts";
import { requireBuild } from "../experiments/file-access.ts";
import { expectEveryHypothesis } from "../experiments/outcome.ts";
import { hostE5 } from "./fixtures/e5-host.ts";
import { test } from "./fixtures/host-chrome.ts";
import { evidence } from "./fixtures/host-env.ts";

/*
 * E5's host twin (POC PLAN.md P3.2): the cells §7.4 runs on the host, on the installed Google
 * Chrome of this Mac and throwaway roots only; expired, corrupt, and Disconnect/Forget stay lab cells.
 */

test.describe("E5 on the host: the handshake over Downloads", () => {
  // Up to five Chrome launches per sample, slower than the lab's; setup counts toward the timeout.
  test.describe.configure({ timeout: 1_800_000 });

  test.beforeAll(async () => {
    await requireBuild(extensionPath("poc-d0"), "poc-d0");
  });

  for (const hypothesis of HOST_CELLS) {
    const run = E5_RUNS[hypothesis];
    test(`${hypothesis}: ${run.title}`, async () => {
      await recordE5(hypothesis, hostE5.target, () => run.sample(hostE5), run.full);
    });
  }

  test("every E5 host hypothesis left a verdict", async () => {
    await expectEveryHypothesis("E5", HOST_CELLS, evidence().directory);
  });
});
