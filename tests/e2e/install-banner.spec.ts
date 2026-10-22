import { expect, test } from "@playwright/test";

test("asks visitors without the extension to install it", async ({ page }) => {
  await page.goto("/");
  const banner = page.getByRole("region", { name: "Install the RECnRun extension" });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("link", { name: "How to install" })).toHaveAttribute(
    "href",
    "https://github.com/RECnRun/recnrun#install-the-extension",
  );
});

test("ships a content security policy without CSP violations", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  await page.goto("/");
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    "content",
    /script-src 'self'/,
  );
  await expect(page.getByRole("heading", { level: 1, name: "RECnRun" })).toBeVisible();
  expect(violations).toEqual([]);
});
