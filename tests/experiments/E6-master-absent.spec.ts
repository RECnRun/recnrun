import { test } from "../browser/fixtures/chrome.ts";
import { extensionPath } from "../browser/fixtures/extension-loaders.ts";
import { E6_RUNS } from "./e6-runs.ts";
import { E6_CELLS, recordE6 } from "./e6-samples.ts";
import type { E6Hypothesis } from "./e6-samples.ts";
import { requireBuild } from "./file-access.ts";
import { labE5 } from "./fixtures/e5-lab.ts";
import { expectEveryHypothesis } from "./outcome.ts";

/*
 * E6 (POC PLAN.md P3.5) in the lab: the Default, bound as master of two workers over Downloads,
 * closes and comes back (E6.a, E6.b), against a worker restart (E6.c); one verdict per cell.
 */

test.describe("E6: master absent and master back, in the lab", () => {
  // Three round trips of three launches and a 75 s absence each; setup counts toward the timeout.
  test.describe.configure({ timeout: 1_200_000 });

  test.beforeAll(async () => {
    await requireBuild(extensionPath("poc-d0"), "poc-d0");
  });

  for (const [hypothesis, run] of Object.entries(E6_RUNS)) {
    test(`${hypothesis}: ${run.title}`, async () => {
      await recordE6(hypothesis as E6Hypothesis, labE5.target, () => run.sample(labE5));
    });
  }

  test("every E6 hypothesis left a verdict", async () => {
    await expectEveryHypothesis("E6", Object.keys(E6_CELLS));
  });
});
