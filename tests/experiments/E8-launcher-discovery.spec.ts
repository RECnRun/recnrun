import { test } from "../browser/fixtures/chrome.ts";
import { extensionPath } from "../browser/fixtures/extension-loaders.ts";
import {
  E8_CELLS,
  findSample,
  notFoundSample,
  osDefaultSample,
  preferencesSample,
  recordE8,
  recordSample,
} from "./e8-samples.ts";
import { requireBuild } from "./file-access.ts";
import { labEnvironment } from "./fixtures/e4-lab.ts";
import { expectEveryHypothesis } from "./outcome.ts";

/*
 * E8 (POC PLAN.md P4.2) in the lab: the launcher's shell chain finds the Downloads root of a profile
 * whose presence carries the token it opened the profile with, step by step.
 */

const target = labEnvironment.target;

test.describe("E8: the launcher finds a profile's Downloads root, in the lab", () => {
  test.beforeAll(async () => {
    await requireBuild(extensionPath("poc-d0"), "poc-d0");
  });

  test("E8.root.preferences: step 1 reads the folder the Preferences name", async () => {
    await recordE8("E8.root.preferences", target, () => preferencesSample(labEnvironment));
  });

  test("E8.root.osDefault: step 2 finds the presence under the OS default", async () => {
    await recordE8("E8.root.osDefault", target, () => osDefaultSample(labEnvironment));
  });

  test("E8.root.record: step 3 finds the presence under a root the record names", async () => {
    await recordE8("E8.root.record", target, () => recordSample(labEnvironment));
  });

  test("E8.root.find: step 4 finds the presence under HOME", async () => {
    await recordE8("E8.root.find", target, () => findSample(labEnvironment));
  });

  test("E8.root.notFound: no presence carries the token, exit 66 with every candidate", async () => {
    await recordE8("E8.root.notFound", target, () => notFoundSample(labEnvironment));
  });

  test("every E8 hypothesis left a verdict", async () => {
    await expectEveryHypothesis("E8", Object.keys(E8_CELLS));
  });
});
