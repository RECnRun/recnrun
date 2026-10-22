import { expect, test } from "@playwright/test";

// Browsers cache favicons for weeks, so only a new file name makes them fetch a new logo.
test("serves every linked icon from a content-hashed file", async ({ page, request }) => {
  await page.goto("/");
  const hrefs = await page
    .locator('link[rel~="icon"], link[rel="apple-touch-icon"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
  expect(hrefs).toHaveLength(3);
  for (const href of hrefs) {
    expect(href).toMatch(/^\/assets\/[\w-]+-[\w-]{8}\.(ico|svg|png)$/);
    expect((await request.get(href)).status()).toBe(200);
  }
});
