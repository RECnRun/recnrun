import { labEnvironment } from "../experiments/fixtures/e4-lab.ts";
import {
  SHARED_CELLS,
  recordShared,
  sharedSample,
} from "../experiments/fixtures/launcher-shared.ts";
import { expectEveryHypothesis } from "../experiments/outcome.ts";
import { expect, test } from "./fixtures/chrome.ts";
import { sharedRig } from "./fixtures/launcher-rig.ts";

/*
 * POC PLAN.md P4.3 on a root shared by two profiles (source question 14.4): Default runs and open.sh
 * is asked for Profile 1. Chrome's process singleton forwards the command line to the running
 * browser and the new process exits (CHROMIUM.md group 2), so the printed pid is a forwarder; the
 * ack under the second profile's Downloads root is the proof that the profile opened.
 */

test.describe("open.sh opens a second profile of a root whose Chrome already runs", () => {
  test.describe.configure({ timeout: 900_000 });

  test("P4.3.open.sharedRoot: the second profile acks through the running Chrome", async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBeDefined();
    await recordShared("P4.3.open.sharedRoot", labEnvironment.target, () =>
      sharedSample(() => sharedRig(testInfo), false),
    );
  });

  test("P4.3.open.sharedRunning: a third open meets the second profile's own boot", async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBeDefined();
    await recordShared("P4.3.open.sharedRunning", labEnvironment.target, () =>
      sharedSample(() => sharedRig(testInfo), true),
    );
  });

  test("every shared-root hypothesis left a verdict", async () => {
    await expectEveryHypothesis("P4.3.shared", Object.keys(SHARED_CELLS));
  });
});
