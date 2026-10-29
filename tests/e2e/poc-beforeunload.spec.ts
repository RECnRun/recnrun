import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import { incognitoWindows } from "./fixtures/identity.ts";
import { lifecycleSetUp } from "./fixtures/lifecycle.ts";

test.use({ incognitoAccess: true });

/**
 * Makes the page ask before it unloads, as Gmail does with a draft; Chrome shows the dialog only
 * after a user activation, so the click gives it one.
 */
async function askBeforeLeaving(page: Page): Promise<string[]> {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    // Dismissing keeps the page, which cancels the close, as "Stay" would.
    void dialog.dismiss();
  });
  await page.evaluate(() => {
    addEventListener("beforeunload", (event) => {
      event.preventDefault();
    });
  });
  await page.locator("body").click();
  expect(await page.evaluate(() => navigator.userActivation.hasBeenActive)).toBe(true);
  return dialogs;
}

test("a page that asks before it unloads neither blocks nor shows a dialog on New identity and Close", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  const a = await askBeforeLeaving(await next());

  await identities.open("B");
  expect(a).toEqual([]);
  const b = await askBeforeLeaving(await next());
  expect(await incognitoWindows(serviceWorker)).toBe(1);

  await identities.suspend();
  expect(b).toEqual([]);
  await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
});

test("a page that asks before it unloads does not block Switch to", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  await next();
  await identities.open("B");
  const b = await askBeforeLeaving(await next());

  await identities.open("A");
  expect(b).toEqual([]);
  await next();
  expect(await incognitoWindows(serviceWorker)).toBe(1);
});
