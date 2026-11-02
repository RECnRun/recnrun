import { defineConfig } from "@playwright/test";

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
    // Google Chrome Stable runs headed on the container's Xvfb display (PLAN.md decision 3).
    headless: false,
    trace: "retain-on-failure",
  },
});
