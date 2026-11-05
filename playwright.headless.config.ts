import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/headless",
  outputDir: "test-results/headless",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 600_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/headless" }]],
  // The specs start Chrome themselves, through the launcher; Playwright's browser is never used.
  use: { headless: false, trace: "off" },
});
