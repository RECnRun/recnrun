import { extensionPath } from "../browser/fixtures/extension-loaders.ts";
import {
  closedProfileSample,
  commonRootSample,
  customRootSample,
  differentRootsSample,
  E4_CELLS,
  manualPathSample,
  preferencesSample,
  recordE4,
} from "../experiments/e4-samples.ts";
import { requireBuild } from "../experiments/file-access.ts";
import { expectEveryHypothesis } from "../experiments/outcome.ts";
import { hostEnvironment, plutilPreference } from "./fixtures/e4-host.ts";
import { test } from "./fixtures/host-chrome.ts";
import { evidence } from "./fixtures/host-env.ts";

/*
 * E4's host twin (POC PLAN.md P2.1): the same cells on the installed Google Chrome of this Mac,
 * on throwaway roots only; the OS default candidate is a stand-in folder, and E4.c reads
 * Preferences with plutil.
 */

const target = hostEnvironment.target;

test.describe("E4 on the host: the launcher discovers profiles and their Downloads roots", () => {
  test.describe.configure({ timeout: 600_000 });

  test.beforeAll(async () => {
    await requireBuild(extensionPath("poc-d0"), "poc-d0");
  });

  test("E4.a.commonRoot: one scan of the default stand-in finds both profiles", async () => {
    await recordE4("E4.a.commonRoot", target, () => commonRootSample(hostEnvironment));
  });

  test("E4.b.differentRoots: the tokens bind each profile to its own root", async () => {
    await recordE4("E4.b.differentRoots", target, () => differentRootsSample(hostEnvironment));
  });

  test("E4.b.customRoot: a folder outside the candidates is not found (limit)", async () => {
    await recordE4("E4.b.customRoot", target, () => customRootSample(hostEnvironment));
  });

  test("E4.b.closedProfile: a quit profile stays listed until its presence expires (limit)", async () => {
    await recordE4("E4.b.closedProfile", target, () => closedProfileSample(hostEnvironment));
  });

  test("E4.c.preferences: plutil reads the folder a root's Preferences name", async () => {
    await recordE4("E4.c.preferences", target, () =>
      preferencesSample(hostEnvironment, plutilPreference),
    );
  });

  test("E4.d.manualPath: typed folders publish to both profiles (control)", async () => {
    await recordE4("E4.d.manualPath", target, () => manualPathSample(hostEnvironment));
  });

  test("every E4 hypothesis left a verdict", async () => {
    await expectEveryHypothesis("E4", Object.keys(E4_CELLS), evidence().directory);
  });
});
