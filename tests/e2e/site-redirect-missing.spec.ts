import { expect, test } from "@playwright/test";

test("visitors without the extension stay on the site and see the install banner", async ({
  baseURL,
  page,
}) => {
  await page.goto("/?redirect=tabs");
  await expect(page.getByRole("region", { name: "Install the RECnRun extension" })).toBeVisible();
  await expect(page).toHaveURL(`${baseURL}/?redirect=tabs`);
});
