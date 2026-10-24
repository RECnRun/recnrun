import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { prepareDevChrome } from "../../scripts/dev-chrome.ts";

test("dev Chrome enables Developer mode and preserves the profile across restarts", async () => {
  const profile = await mkdtemp(join(tmpdir(), "recnrun-dev-chrome-"));
  const options = { executablePath: chromium.executablePath(), headless: false };
  try {
    const context = await chromium.launchPersistentContext(profile, options);
    try {
      const page = await context.newPage();
      await page.goto("chrome://extensions");
      await expect(
        page.getByRole("switch", { name: "Developer mode", exact: true }),
      ).not.toBeChecked();
      await context.addCookies([
        { name: "dev-profile", value: "preserved", url: "https://example.test", expires: 2e9 },
      ]);
    } finally {
      await context.close();
    }

    for (let run = 0; run < 2; run++) {
      await prepareDevChrome(profile, options);
      const reopened = await chromium.launchPersistentContext(profile, options);
      try {
        const page = await reopened.newPage();
        await page.goto("chrome://extensions");
        await expect(
          page.getByRole("switch", { name: "Developer mode", exact: true }),
        ).toBeChecked();
        expect(await reopened.cookies("https://example.test")).toEqual([
          expect.objectContaining({ name: "dev-profile", value: "preserved" }),
        ]);
      } finally {
        await reopened.close();
      }
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
