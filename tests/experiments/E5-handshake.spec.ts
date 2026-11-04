import { test } from "../browser/fixtures/chrome.ts";
import { extensionPath } from "../browser/fixtures/extension-loaders.ts";
import { E5_RUNS } from "./e5-runs.ts";
import { E5_CELLS, recordE5 } from "./e5-samples.ts";
import type { E5Hypothesis } from "./e5-samples.ts";
import { requireBuild } from "./file-access.ts";
import { labE5 } from "./fixtures/e5-lab.ts";
import { expectEveryHypothesis } from "./outcome.ts";

/*
 * E5 (POC PLAN.md P3.2) in the lab: poc-d0 pairs over Downloads with no picker and no gesture,
 * the Default plus one worker (E5.a), then the Default plus four (E5.b); one verdict per cell.
 */

test.describe("E5: the handshake over Downloads, in the lab", () => {
  // Three samples of up to five Chrome launches each; setup counts toward the test's own timeout.
  test.describe.configure({ timeout: 1_200_000 });

  test.beforeAll(async () => {
    await requireBuild(extensionPath("poc-d0"), "poc-d0");
  });

  for (const [hypothesis, run] of Object.entries(E5_RUNS)) {
    test(`${hypothesis}: ${run.title}`, async () => {
      const sample = () => run.sample(labE5);
      await recordE5(hypothesis as E5Hypothesis, labE5.target, sample, run.full);
    });
  }

  test("every E5 hypothesis left a verdict", async () => {
    await expectEveryHypothesis("E5", Object.keys(E5_CELLS));
  });
});
