import { test } from "../browser/fixtures/chrome.ts";
import { extensionPath } from "../browser/fixtures/extension-loaders.ts";
import { E9_CELLS, recordE9 } from "./e9-lifecycle.ts";
import type { E9Hypothesis } from "./e9-lifecycle.ts";
import { requireBuild } from "./file-access.ts";
import { labEnvironment } from "./fixtures/e4-lab.ts";
import { expectEveryHypothesis } from "./outcome.ts";

/*
 * E9 (POC PLAN.md P4.4) in the lab: lifecycle.sh on real Chrome roots, one rig per sample with HOME
 * inside it. Nothing outside the rig is read or signalled.
 */

test.describe("E9: the launcher's lifecycle rules, in the lab", () => {
  test.describe.configure({ timeout: 900_000 });

  test.beforeAll(async () => {
    await requireBuild(extensionPath("poc-d0"), "poc-d0");
  });

  const titles: Record<E9Hypothesis, string> = {
    "E9.duplicate": "two concurrent requests start one Chrome, and the other exits 75",
    "E9.idempotent": "a request on a running profile prints its boot and starts nothing",
    "E9.backoff": "a failed open exits 70 and the next request waits for nextAt",
    "E9.restart": "a crashed Chrome with a stale presence is relaunched with a new boot",
    "E9.stop": "stop signals the launched Chrome only and leaves no temporary file",
    "E9.pause": "a paused profile exits 73 until it is resumed",
  };
  for (const hypothesis of Object.keys(E9_CELLS) as E9Hypothesis[]) {
    test(`${hypothesis}: ${titles[hypothesis]}`, async () => {
      await recordE9(hypothesis, labEnvironment.target);
    });
  }

  test("every E9 hypothesis left a verdict", async () => {
    await expectEveryHypothesis("E9", Object.keys(E9_CELLS));
  });
});
