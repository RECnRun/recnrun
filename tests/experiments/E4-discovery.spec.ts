import { test } from "../browser/fixtures/chrome.ts";
import { extensionPath } from "../browser/fixtures/extension-loaders.ts";
import {
  closedProfileSample,
  commonRootSample,
  customRootSample,
  differentRootsSample,
  E4_CELLS,
  e4Cell,
  manualPathSample,
  PREFERENCES_REASON,
  preferencesSample,
  recordE4,
} from "./e4-samples.ts";
import { recordUnavailableSeen } from "./e3-samples.ts";
import { requireBuild } from "./file-access.ts";
import { labEnvironment } from "./fixtures/e4-lab.ts";
import { expectEveryHypothesis } from "./outcome.ts";

/*
 * E4 (POC PLAN.md P2.1) in the lab: the launcher opens each profile's bootstrap page with a token,
 * finds the presence carrying it in a candidate Downloads folder, and runs catalog.sh per root.
 */

const target = labEnvironment.target;

test.describe("E4: the launcher discovers profiles and their Downloads roots, in the lab", () => {
  test.beforeAll(async () => {
    await requireBuild(extensionPath("poc-d0"), "poc-d0");
  });

  test("E4.a.commonRoot: one scan of the OS default finds both profiles", async () => {
    await recordE4("E4.a.commonRoot", target, () => commonRootSample(labEnvironment));
  });

  test("E4.b.differentRoots: the tokens bind each profile to its own root", async () => {
    await recordE4("E4.b.differentRoots", target, () => differentRootsSample(labEnvironment));
  });

  test("E4.b.customRoot: a folder outside the candidates is not found (limit)", async () => {
    await recordE4("E4.b.customRoot", target, () => customRootSample(labEnvironment));
  });

  test("E4.b.closedProfile: a quit profile stays listed until its presence expires (limit)", async () => {
    await recordE4("E4.b.closedProfile", target, () => closedProfileSample(labEnvironment));
  });

  test("E4.c.preferences: unavailable on Linux, with what JSON.parse reads", async () => {
    const seen = (await preferencesSample(labEnvironment)).observation;
    await recordUnavailableSeen(await e4Cell("E4.c.preferences", target), PREFERENCES_REASON, seen);
  });

  test("E4.d.manualPath: typed folders publish to both profiles (control)", async () => {
    await recordE4("E4.d.manualPath", target, () => manualPathSample(labEnvironment));
  });

  test("every E4 hypothesis left a verdict", async () => {
    await expectEveryHypothesis("E4", Object.keys(E4_CELLS));
  });
});
