import { labEnvironment } from "../experiments/fixtures/e4-lab.ts";
import { OPEN_CELLS, openSample, recordOpen } from "../experiments/fixtures/launcher-open.ts";
import { expectEveryHypothesis } from "../experiments/outcome.ts";
import { expect, test } from "./fixtures/chrome.ts";
import { labRig } from "./fixtures/launcher-rig.ts";

/*
 * POC PLAN.md P4.3 on Google Chrome Stable: the launcher's open.sh starts a second root's Chrome
 * with the bootstrap URL on its command line and waits for the ack the extension writes under that
 * profile's Downloads root. The root is prepared the lab's way (poc-d0 by Extensions.loadUnpacked,
 * reloaded once so it outlives the process, see CHROMIUM.md group 9), then quit with SIGTERM.
 */

test.describe("open.sh opens a second root's profile and gets the ack of its token", () => {
  test.describe.configure({ timeout: 600_000 });

  test("P4.3.open.fresh: a closed profile starts and acks its token as its boot", async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBeDefined();
    await recordOpen("P4.3.open.fresh", labEnvironment.target, () =>
      openSample(() => labRig(testInfo), false),
    );
  });

  test("P4.3.open.running: a second open acks the running profile's own boot", async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBeDefined();
    await recordOpen("P4.3.open.running", labEnvironment.target, () =>
      openSample(() => labRig(testInfo), true),
    );
  });

  test("every P4.3 hypothesis left a verdict", async () => {
    await expectEveryHypothesis("P4.3", Object.keys(OPEN_CELLS));
  });
});
