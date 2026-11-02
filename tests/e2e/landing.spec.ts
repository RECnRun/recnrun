import { expect, test } from "@playwright/test";

test("introduces RECnRun and shows the install commands", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "RECnRun" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Chrome DevTools Protocol");
  const install = page.getByRole("region", { name: "Install" });
  await expect(install.getByRole("listitem").getByRole("code")).toHaveText([
    "npx @recnrun/cli setup",
    "npx @recnrun/cli open",
  ]);
  await expect(install).toContainText("not published yet");
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
