import { labEnvironment } from "../experiments/fixtures/e4-lab.ts";
import {
  COMMAND_CELLS,
  commandsSample,
  recordCommands,
} from "../experiments/fixtures/launcher-commands.ts";
import { expectEveryHypothesis } from "../experiments/outcome.ts";
import { expect, test } from "./fixtures/chrome.ts";
import { labRig } from "./fixtures/launcher-rig.ts";

/*
 * POC PLAN.md P4.5 on Google Chrome Stable: recnrun-launcher.sh `start --once` opens a registered
 * root's profile through lifecycle.sh and open.sh, `status` lists it, and `stop --all` ends it.
 */

test.describe("recnrun-launcher.sh start, status, and stop on a second root", () => {
  test.describe.configure({ timeout: 600_000 });

  test("P4.5.commands.once: start --once opens the profile, status lists it, stop --all ends it", async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBeDefined();
    await recordCommands("P4.5.commands.once", labEnvironment.target, () =>
      commandsSample(() => labRig(testInfo)),
    );
  });

  test("every P4.5 hypothesis left a verdict", async () => {
    await expectEveryHypothesis("P4.5", Object.keys(COMMAND_CELLS));
  });
});
