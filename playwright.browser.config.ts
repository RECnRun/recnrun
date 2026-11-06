import { defineConfig } from "@playwright/test";

const baseURL = "http://localhost:5190";

// One evidence directory per run; workers inherit it (tests/experiments/verdicts.ts).
process.env.RECNRUN_RUN_ID ??= new Date().toISOString().replaceAll(":", "-");

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
    baseURL,
    // Google Chrome Stable runs headed on the container's Xvfb display (POC PLAN.md decision 3).
    headless: false,
    trace: "retain-on-failure",
  },
  // The mesh pairs dashboards beside a page of the website, as tests/e2e does.
  webServer: {
    command: "vp run website#preview -- --port 5190 --strictPort --host localhost",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
