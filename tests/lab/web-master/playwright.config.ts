import { defineConfig } from "@playwright/test";

// One evidence directory per run, exported by the Docker runner.
process.env.RECNRUN_RUN_ID ??= new Date().toISOString().replaceAll(":", "-");

export default defineConfig({
  testDir: ".",
  // The envelope's Node tests (*.test.ts) belong to Vitest's harness project.
  testMatch: /.*\.spec\.ts$/,
  outputDir: "../../../test-results/lab",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  // A failed hypothesis is the answer; a retry would hide it.
  retries: 0,
  timeout: 180_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "../../../playwright-report/lab" }]],
  // The specs start Google Chrome Stable themselves; Playwright's browser is never used.
  use: { headless: false, trace: "off" },
  // W.lifecycle and W6.A run again with a headless worker root; the master stays headed.
  projects: [
    { name: "headed-worker" },
    { name: "headless-worker", testMatch: /w-(lifecycle|visual)\.spec\.ts$/ },
  ],
});
