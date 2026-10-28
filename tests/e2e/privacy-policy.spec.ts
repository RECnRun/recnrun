import { expect, test } from "@playwright/test";
import { test as withExtension } from "./fixtures/extension.ts";

const POLICY = "/privacy/";

test("serves the privacy policy as its own page", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  const response = await page.goto(POLICY);
  // GitHub Pages answers a path without its own file through 404.html, with status 404.
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("Privacy policy · RECnRun");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();
  await expect(page.getByRole("link", { name: "hello@recnrun.com" })).toHaveAttribute(
    "href",
    "mailto:hello@recnrun.com",
  );
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    "content",
    /script-src 'self'/,
  );
  expect(violations).toEqual([]);
});

test("links to the privacy policy from the home page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Privacy policy" }).click();
  await expect(page).toHaveURL(POLICY);
});

withExtension(
  "leaves the privacy policy readable when the extension is installed",
  async ({ page }) => {
    await page.goto(POLICY);
    await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
  },
);
