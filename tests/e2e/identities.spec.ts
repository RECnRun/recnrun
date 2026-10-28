import type { Page, Worker } from "@playwright/test";
import { BLANK } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { keep } from "./fixtures/keep.ts";
import { closeTab, failNext, incognitoWindows } from "./fixtures/identity.ts";
import { clickInDashboard, dashboardOf, openSite } from "./fixtures/session.ts";
import { openIncognitoTab } from "./fixtures/tabs.ts";
import { pageAt, workspacePanel } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

/** Saves what the dashboard shows next to the test's results, for a person to look at. */
const screen = (site: Page, name: string) =>
  site.screenshot({ path: test.info().outputPath(`${name}.png`) });

const identity = (site: Page, label: string) =>
  dashboardOf(site)
    .getByRole("list", { name: "Saved identities" })
    .getByRole("listitem", { name: label, exact: true });

const click = (site: Page, label: string, action: string) =>
  clickInDashboard(identity(site, label).getByRole("button", { name: action, exact: true }));

/** The marker the identity's page keeps in its localStorage, read from the managed tab. */
const marker = async (site: Page) =>
  (await pageAt(site.context(), BLANK)).evaluate(() => localStorage.getItem("who"));

const mark = async (site: Page, who: string) =>
  (await pageAt(site.context(), BLANK)).evaluate(
    (value) => localStorage.setItem("who", value),
    who,
  );

/** The workspace holds `label` once its command returned, which is after the barrier reload. */
async function opened(site: Page, label: string) {
  await expect(workspacePanel(site)).toContainText(`Incognito workspace open: ${label}`);
  await expect(identity(site, label).getByRole("button", { name: "Suspend" })).toBeEnabled();
}

/** Creates an identity from the panel at the blank page and waits for its window. */
async function newIdentity(site: Page, label: string) {
  const panel = workspacePanel(site);
  await panel.getByRole("textbox", { name: "Address" }).fill(BLANK);
  await panel.getByRole("textbox", { name: "Label" }).fill(label);
  await clickInDashboard(panel.getByRole("button", { name: "New identity", exact: true }));
  await opened(site, label);
}

const timed = async (run: () => Promise<void>) => {
  const started = Date.now();
  await run();
  return Date.now() - started;
};

async function setUp(context: Parameters<typeof openSite>[0], serviceWorker: Worker) {
  const site = await openSite(context, "/");
  await newIdentity(site, "Admin");
  await mark(site, "Admin");
  await newIdentity(site, "Guest");
  await expect.poll(() => marker(site)).toBeNull();
  await mark(site, "Guest");
  await expect(identity(site, "Admin")).toContainText("Saved");
  expect(await incognitoWindows(serviceWorker)).toBe(1);
  return site;
}

test("New identity, Switch to, Suspend, Resume, and Delete from the dashboard", async ({
  context,
  serviceWorker,
}) => {
  const site = await setUp(context, serviceWorker);
  await screen(site, "guest-open");
  const timings = {
    switch: await timed(async () => {
      await click(site, "Admin", "Switch to");
      await opened(site, "Admin");
    }),
    suspend: 0,
    resume: 0,
  };
  await expect.poll(() => marker(site)).toBe("Admin");
  await expect(identity(site, "Guest")).toContainText(/Saved .+, about \d+ B/);

  timings.suspend = await timed(async () => {
    await click(site, "Admin", "Suspend");
    await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
  });
  await expect(identity(site, "Guest").getByRole("button", { name: "Resume" })).toBeEnabled();
  await screen(site, "suspended");

  timings.resume = await timed(async () => {
    await click(site, "Guest", "Resume");
    await opened(site, "Guest");
  });
  await expect.poll(() => marker(site)).toBe("Guest");

  await click(site, "Admin", "Delete");
  await click(site, "Admin", "Delete Admin");
  await expect(identity(site, "Admin")).toHaveCount(0);
  await expect(identity(site, "Guest")).toContainText("Open");
  await keep("identity-commands-ms", timings);
});

test("another Incognito window disables switching until it closes", async ({
  context,
  serviceWorker,
}) => {
  const site = await setUp(context, serviceWorker);
  const stray = await openIncognitoTab(serviceWorker, "about:blank");
  const switchTo = identity(site, "Admin").getByRole("button", { name: "Switch to" });
  await expect(workspacePanel(site)).toContainText("Another Incognito window or tab is open.");
  await expect(switchTo).toBeDisabled();
  await expect(identity(site, "Admin").getByRole("button", { name: "Delete" })).toBeEnabled();
  await screen(site, "conflict");
  if (stray === undefined) throw new Error("No stray Incognito tab opened.");
  await closeTab(serviceWorker, stray);
  await expect(switchTo).toBeEnabled();
});

test("a failed resume names its step and opens no window", async ({ context, serviceWorker }) => {
  const site = await setUp(context, serviceWorker);
  await click(site, "Guest", "Suspend");
  await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
  await failNext(serviceWorker, "restore");
  await click(site, "Admin", "Resume");
  const alert = workspacePanel(site).getByRole("alert").first();
  await expect(alert).toContainText("Resume failed at the restore step.");
  await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
  await screen(site, "failed-resume");
  await click(site, "Admin", "Resume");
  await opened(site, "Admin");
  await expect.poll(() => marker(site)).toBe("Admin");
});
