import { chromium } from "@playwright/test";

export async function prepareDevChrome(
  profile: string,
  launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = { channel: "chrome" },
) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...launchOptions,
  });
  try {
    const page = await context.newPage();
    await page.goto("chrome://extensions");
    await page.locator("#devMode").setChecked(true);
  } finally {
    await context.close();
  }
}
