import { pair } from "../e2e/fixtures/folder.ts";
import { expect, test } from "./fixtures/chrome-profiles.ts";

/*
 * POC PLAN.md P0.3 and the regression of §5 item 2 on the branded browser: two throwaway roots
 * on Google Chrome Stable pair over the existing File System Access folder transport, through
 * Chrome's own picker and prompts, as tests/e2e/cross-profile-mesh.spec.ts does on Chromium.
 */

test("two Google Chrome Stable roots pair over the RECnRun folder and both reach Connected", async ({
  chromeA,
  chromeB,
  native,
}) => {
  test.setTimeout(180_000);
  for (const profile of [chromeA, chromeB]) expect(profile.version).toMatch(/^Google Chrome \d+\./);
  expect(chromeB.dir).not.toBe(chromeA.dir);
  await pair(chromeA, chromeB, native);
});
