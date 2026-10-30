import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://localhost:5190";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/e2e" }]],
  use: {
    baseURL,
    // Chromium loads unpacked extensions only in headed mode; the container provides Xvfb.
    headless: false,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "vp run website#preview -- --port 5190 --strictPort --host localhost",
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Serves app.localhost:5192 and other.localhost:5192; Node may not resolve *.localhost.
      command: "node tests/e2e/apps/server.ts",
      url: "http://localhost:5192/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
