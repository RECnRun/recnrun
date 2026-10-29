import type { Page } from "@playwright/test";
import { expect } from "./extension.ts";
import { clickInFrame, dashboardOf } from "./session.ts";
import { workspacePanel } from "./workspace.ts";

/** One saved identity's row in the panel. */
export const identity = (site: Page, label: string) =>
  dashboardOf(site)
    .getByRole("list", { name: "Saved identities" })
    .getByRole("listitem", { name: label, exact: true });

/** `label` is Open and its command returned: Close waits while the command, and the barrier, run. */
export async function opened(site: Page, label: string) {
  await expect(identity(site, label).getByText("Open", { exact: true })).toBeVisible();
  await expect(
    identity(site, label).getByRole("button", { name: "Close", exact: true }),
  ).toBeEnabled();
}

/** Types `url` in the panel's Address and clicks New identity, as the user would. */
export async function newIdentity(site: Page, url: string) {
  const panel = workspacePanel(site);
  await panel.getByRole("combobox", { name: "Address" }).fill(url);
  await clickInFrame(panel.getByRole("button", { name: "New identity", exact: true }));
}

export const switchTo = (site: Page, label: string) =>
  clickInFrame(identity(site, label).getByRole("button", { name: "Switch to", exact: true }));

/**
 * Makes the page ask before it unloads, as Gmail does with a draft; Chrome shows the dialog only
 * after a user activation, so the click gives it one. Returns each dialog Chrome shows.
 */
export async function askBeforeLeaving(page: Page): Promise<string[]> {
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
