import type { Page } from "@playwright/test";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";
import {
  dashboardAccessible,
  expectBlocked,
  dashboardUrl,
  declarativeRedirect,
  expectDashboard,
  trackNavigations,
} from "./fixtures/redirect.ts";

// B: the site's own script navigates to the extension; C: a declarativeNetRequest rule.

type Navigate = (page: Page, url: string) => Promise<void>;

const navigations: Record<string, Navigate> = {
  "location.href": (page, url) =>
    page.evaluate((target) => {
      window.location.href = target;
    }, url),
  "location.replace": (page, url) =>
    page.evaluate((target) => window.location.replace(target), url),
  "a link click": async (page, url) => {
    await page.evaluate((target) => {
      const link = document.createElement("a");
      link.href = target;
      link.textContent = "Open the dashboard";
      document.body.prepend(link);
    }, url);
    await page.getByRole("link", { name: "Open the dashboard" }).click();
  },
};

test.beforeEach(async ({ seedSnapshot }) => {
  await seedSnapshot(sampleSnapshot());
});

for (const [name, navigate] of Object.entries(navigations)) {
  test(`B: ${name} from the site is blocked while dashboard.html is not web accessible`, async ({
    extensionId,
    page,
  }) => {
    await page.goto("/");
    const log = trackNavigations(page);
    await navigate(page, dashboardUrl(extensionId));
    const outcome = await expectBlocked(page, log);
    console.log(`B ${name} without WAR`, outcome, JSON.stringify(log));
  });
}

test.describe("with dashboard.html web accessible to the site", () => {
  test.use({ manifestPatch: { patch: dashboardAccessible } });

  for (const [name, navigate] of Object.entries(navigations)) {
    test(`B: ${name} from the site reaches the dashboard`, async ({
      baseURL,
      extensionId,
      page,
    }) => {
      await page.goto("/");
      const log = trackNavigations(page);
      await navigate(page, dashboardUrl(extensionId));
      await expectDashboard(page, extensionId);
      const back = await page.goBack({ waitUntil: "commit" });
      console.log(`B ${name} with WAR`, JSON.stringify(log), "goBack:", back?.url() ?? null);
      if (name === "location.replace") expect(page.url()).not.toBe(`${baseURL}/`);
      else expect(page.url()).toBe(`${baseURL}/`);
    });
  }
});

interface DnrGlobal {
  chrome: { declarativeNetRequest: { updateDynamicRules(options: object): Promise<void> } };
}

for (const accessible of [false, true]) {
  test.describe(`C: declarativeNetRequest with dashboard.html ${accessible ? "" : "not "}web accessible`, () => {
    test.use({ manifestPatch: { patch: declarativeRedirect(accessible) } });

    test("redirects the site request to the dashboard", async ({
      extensionId,
      page,
      serviceWorker,
    }) => {
      await serviceWorker.evaluate(() =>
        (globalThis as unknown as DnrGlobal).chrome.declarativeNetRequest.updateDynamicRules({
          addRules: [
            {
              id: 1,
              action: { type: "redirect", redirect: { extensionPath: "/dashboard.html" } },
              condition: { urlFilter: "/?redirect=dnr", resourceTypes: ["main_frame"] },
            },
          ],
        }),
      );
      const log = trackNavigations(page);
      const response = await page
        .goto("/?redirect=dnr", { waitUntil: "commit" })
        .catch((error: unknown) => String(error));
      console.log(
        `C accessible=${accessible}`,
        JSON.stringify(log),
        "goto:",
        typeof response === "string" ? response : response?.url(),
      );
      await expectDashboard(page, extensionId);
      const back = await page.goBack({ waitUntil: "commit" });
      console.log(`C accessible=${accessible} goBack:`, back?.url() ?? null, page.url());
    });
  });
}
