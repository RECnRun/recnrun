import { defineConfig } from "@playwright/test";

// One person, one Chrome, one display: the desktop layer is serial and never retried.
export default defineConfig({
  testDir: "./tests/desktop",
  outputDir: "test-results/desktop",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 180_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/desktop" }]],
  use: {
    headless: false,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // first-use.spec.ts records and replays this application on port 4600.
      command: "vp run @recnrun/fixture#start",
      url: "http://127.0.0.1:4600/",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
