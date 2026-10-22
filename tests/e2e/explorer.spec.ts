import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";

test("shows the recordings stored in the extension, newest first", async ({
  page,
  seedSnapshot,
}) => {
  await seedSnapshot(sampleSnapshot());
  await page.goto("/");

  const recordings = page.getByRole("article");
  await expect(recordings).toHaveCount(2);
  await expect(recordings.first()).toHaveAccessibleName("Checkout with saved card");
  await expect(recordings.first()).toContainText("https://staging.shop.example/cart");
  await expect(recordings.first()).toContainText("31 events");
  await expect(page.getByRole("article", { name: "Log in as admin" })).toContainText("12 s");
  await expect(page.getByRole("region", { name: "Install the RECnRun extension" })).toHaveCount(0);
  await expect(page.getByTestId("extension-version")).toHaveText("Extension 0.1.0");
});

test("explains an empty extension instead of asking to install it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No recordings yet" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Install the RECnRun extension" })).toHaveCount(0);
});
