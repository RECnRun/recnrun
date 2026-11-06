import { labEnvironment } from "../experiments/fixtures/e4-lab.ts";
import {
  FIRST_RUN_CELLS,
  firstRunSample,
  recordFirstRun,
} from "../experiments/fixtures/launcher-first-run.ts";
import { expectEveryHypothesis } from "../experiments/outcome.ts";
import { expect, test } from "./fixtures/chrome.ts";
import { firstRunRig } from "./fixtures/launcher-rig.ts";

/*
 * POC PLAN.md P4.6 on the usual layout (Codex review of Gate P4, finding 6): the OS default Chrome
 * root holds Default and Profile 1, both with the extension and both downloading to ~/Downloads.
 * The launcher never reads that root, so first-run.sh binds only the Default through its token ack,
 * writes the acked id into an empty record, and status lists it open; Profile 1 is ignored.
 */

test.describe("first-run.sh on a Downloads root two profiles share", () => {
  test.describe.configure({ timeout: 900_000 });

  test("P4.6.firstRun.sharedRoot: the Default is bound, registered, and open; Profile 1 is ignored", async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBeDefined();
    await recordFirstRun("P4.6.firstRun.sharedRoot", labEnvironment.target, () =>
      firstRunSample(() => firstRunRig(testInfo)),
    );
  });

  test("every P4.6 shared-root hypothesis left a verdict", async () => {
    await expectEveryHypothesis("P4.6", Object.keys(FIRST_RUN_CELLS));
  });
});
