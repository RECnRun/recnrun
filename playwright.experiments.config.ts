import { defineConfig } from "@playwright/test";

// One evidence directory per run; workers inherit it (tests/experiments/verdicts.ts).
process.env.RECNRUN_RUN_ID ??= new Date().toISOString().replaceAll(":", "-");

export default defineConfig({
  testDir: "./tests/experiments",
  outputDir: "test-results/experiments",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  // A retry would append a second verdict for the same hypothesis; a failure is a verdict.
  retries: 0,
  timeout: 600_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/experiments" }]],
  use: {
    // Google Chrome Stable runs headed on the container's Xvfb display (POC PLAN.md decision 3).
    headless: false,
    trace: "retain-on-failure",
  },
});
