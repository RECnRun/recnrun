import { defineConfig } from "@playwright/test";
import browser from "./playwright.browser.config.ts";

export default defineConfig(browser, {
  testDir: "./tests/experiments",
  outputDir: "test-results/experiments",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/experiments" }]],
});
