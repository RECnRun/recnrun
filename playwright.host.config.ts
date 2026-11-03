import { defineConfig } from "@playwright/test";

// One run id names the roots and the evidence of a run; workers inherit it (tests/host/fixtures).
process.env.RECNRUN_RUN_ID ??= `host-${new Date().toISOString().replaceAll(":", "-")}`;

// The installed Google Chrome of this Mac (POC PLAN.md P0.5); never in Docker, never in verify.
export default defineConfig({
  testDir: "./tests/host",
  // roots.test.ts beside the specs is a Node unit test of the harness project.
  testMatch: "*.spec.ts",
  outputDir: "test-results/host",
  globalSetup: "./tests/host/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  // A retry would launch the owner's machine's Chrome again for a failure that is evidence.
  retries: 0,
  timeout: 120_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/host" }]],
  use: {
    headless: false,
    trace: "off",
  },
});
