import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "test-results/browser",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/browser" }]],
  use: {
    headless: false,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // tests/browser/fixtures/fixture-app.ts expects these two ports.
      command: "vp run @recnrun/fixture#start",
      url: "http://127.0.0.1:4600/",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
