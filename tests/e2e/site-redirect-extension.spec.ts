import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";
import {
  dashboardAccessible,
  expectBlocked,
  expectDashboard,
  expectToStay,
  trackNavigations,
} from "./fixtures/redirect.ts";

// Mechanisms the extension drives itself; the site needs no extension id.

test.beforeEach(async ({ seedSnapshot }) => {
  await seedSnapshot(sampleSnapshot());
});

test("A: the background moves a recnrun.com tab to the dashboard with tabs.update", async ({
  baseURL,
  extensionId,
  page,
}) => {
  const log = trackNavigations(page);
  await page.goto("/?redirect=tabs", { waitUntil: "commit" });
  await expectDashboard(page, extensionId);
  console.log("A forward", JSON.stringify(log));

  await page.goBack({ waitUntil: "commit" });
  await expectToStay(page, `${baseURL}/?redirect=tabs`);
  await expect(page.getByRole("heading", { level: 1, name: "RECnRun" })).toBeVisible();
  console.log("A after Back", JSON.stringify(log));
});

test.describe("A': the content script calls location.replace", () => {
  test("is blocked while dashboard.html is not web accessible", async ({ extensionId, page }) => {
    const log = trackNavigations(page);
    await page.goto("/?redirect=replace", { waitUntil: "commit" });
    const outcome = await expectBlocked(page, log);
    console.log("A' without WAR", extensionId, outcome, JSON.stringify(log));
  });

  test.describe("with dashboard.html web accessible to the site", () => {
    test.use({ manifestPatch: { patch: dashboardAccessible } });

    test("lands on the dashboard without a history entry for the site", async ({
      extensionId,
      page,
    }) => {
      const log = trackNavigations(page);
      await page.goto("/?redirect=replace", { waitUntil: "commit" });
      await expectDashboard(page, extensionId);
      const back = await page.goBack({ waitUntil: "commit" });
      console.log("A' with WAR", JSON.stringify(log), "goBack:", back?.url() ?? null);
      expect(page.url()).not.toContain("redirect=replace");
    });
  });
});
