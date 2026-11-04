import { extensionPath } from "../browser/fixtures/extension-loaders.ts";
import {
  E8_CELLS,
  findSample,
  notFoundSample,
  osDefaultSample,
  preferencesSample,
  recordE8,
  recordSample,
} from "../experiments/e8-samples.ts";
import { requireBuild } from "../experiments/file-access.ts";
import { expectEveryHypothesis } from "../experiments/outcome.ts";
import { hostEnvironment } from "./fixtures/e4-host.ts";
import { test } from "./fixtures/host-chrome.ts";
import { evidence } from "./fixtures/host-env.ts";

/*
 * E8's host twin (POC PLAN.md P4.2): the same five cells on the installed Google Chrome of this Mac,
 * on throwaway roots only. HOME for the chain is a throwaway folder, so ~/Downloads is never read,
 * and the chain reads Preferences with plutil, which exists here.
 */

const target = hostEnvironment.target;

test.describe("E8 on the host: the launcher finds a profile's Downloads root", () => {
  test.describe.configure({ timeout: 600_000 });

  test.beforeAll(async () => {
    await requireBuild(extensionPath("poc-d0"), "poc-d0");
  });

  test("E8.root.preferences: step 1 reads the folder the Preferences name", async () => {
    await recordE8("E8.root.preferences", target, () => preferencesSample(hostEnvironment));
  });

  test("E8.root.osDefault: step 2 finds the presence under the OS default", async () => {
    await recordE8("E8.root.osDefault", target, () => osDefaultSample(hostEnvironment));
  });

  test("E8.root.record: step 3 finds the presence under a root the record names", async () => {
    await recordE8("E8.root.record", target, () => recordSample(hostEnvironment));
  });

  test("E8.root.find: step 4 finds the presence under HOME", async () => {
    await recordE8("E8.root.find", target, () => findSample(hostEnvironment));
  });

  test("E8.root.notFound: no presence carries the token, exit 66 with every candidate", async () => {
    await recordE8("E8.root.notFound", target, () => notFoundSample(hostEnvironment));
  });

  test("every E8 hypothesis left a verdict", async () => {
    await expectEveryHypothesis("E8", Object.keys(E8_CELLS), evidence().directory);
  });
});
