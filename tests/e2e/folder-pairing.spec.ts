import type { BrowserContext, Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "./fixtures/extension.ts";
import { test } from "./fixtures/native-dialogs.ts";
import type { Native } from "./fixtures/native-dialogs.ts";
import type { Profile } from "./fixtures/profiles.ts";
import { dashboardOf } from "./fixtures/session.ts";

/*
 * Both profiles choose one real folder on the container's disk through Chrome's own picker
 * and answer its prompts (H4), so the files one profile writes are the ones the other reads.
 */

interface ChromeGlobal {
  chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
}

const WAITING = "Waiting for another profile in the folder…";

const profileIdOf = (profile: Pick<Profile, "serviceWorker">) =>
  profile.serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const { profileIdentity } = await chrome.storage.local.get("profileIdentity");
    return (profileIdentity as { profileId: string }).profileId;
  });

const folderSection = (page: Page) => page.locator('section[aria-labelledby="folder-heading"]');

const presenceOf = (folder: string, profileId: string) =>
  JSON.parse(readFileSync(join(folder, "pairing", profileId, "presence.json"), "utf8"));

/** Chooses `folder` through Chrome's picker on `page`, then lets the site edit it. */
async function chooseFolder(page: Page, { dialogs, folder }: Native) {
  const native = await dialogs(page);
  await page.getByRole("button", { name: "Choose folder" }).click();
  await native.chooseFolder(folder);
  await native.answerWritePrompt("allow");
}

/** Both profiles choose the folder; A's page stays open, or Chrome drops A's grant (H2). */
async function pairThroughFolder(a: Profile, b: Profile, native: Native) {
  await chooseFolder(a.pairing, native);
  await expect(folderSection(a.pairing)).toContainText(WAITING);
  await chooseFolder(b.pairing, native);
  await expect(b.pairing.getByRole("status")).toHaveText(`Connected — ${a.name}`, {
    timeout: 30_000,
  });
  await expect(folderSection(b.pairing)).toContainText(`Paired with ${a.name}`);
}

const extensionPage = async (
  profile: Pick<Profile, "context" | "serviceWorker">,
  path = "pairing.html",
) => {
  const page = await profile.context.newPage();
  await page.goto(new URL(path, profile.serviceWorker.url()).href);
  return page;
};

/** Quits the profile's browser, waits until `watching` saw it go, and starts it again. */
async function restart(
  profile: Profile,
  watching: Page,
  launch: (dir: string) => Promise<BrowserContext>,
): Promise<Profile> {
  await profile.context.close();
  // No close message comes from a browser that quits; ICE consent checks find it gone.
  await expect(watching.getByRole("status")).toHaveText(
    /^(Disconnected|Not reachable) — Profile B$/,
    { timeout: 45_000 },
  );
  const context = await launch(profile.dir);
  const serviceWorker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  return { ...profile, context, serviceWorker };
}

test("two profiles pair through one RECnRun folder on disk", async ({
  profileA,
  profileB,
  native,
}) => {
  await pairThroughFolder(profileA, profileB, native);
  await expect(profileA.pairing.getByRole("status")).toHaveText(`Connected — ${profileB.name}`);
  await expect(folderSection(profileA.pairing)).toContainText(`Paired with ${profileB.name}`);
  // Paired, each profile stays in the folder, so its peer finds it after a restart.
  for (const profile of [profileA, profileB])
    expect(presenceOf(native.folder, await profileIdOf(profile))).toMatchObject({
      displayName: profile.name,
    });
});

const extensionPages = (profile: Pick<Profile, "context">) =>
  profile.context.pages().filter((page) => page.url().startsWith("chrome-extension://"));

test("a restarted profile allows the folder once more, keeps it with no page open, and reconnects with no click after later restarts", async ({
  profileA,
  profileB,
  native,
  launch,
}) => {
  test.setTimeout(300_000);
  await pairThroughFolder(profileA, profileB, native);
  const watching = profileA.pairing;
  // H1: after the first restart, Chrome asks once more; "Allow on every visit" ends that.
  let restarted = await restart(profileB, watching, launch);
  const window = await extensionPage(restarted, "pairing.html#folder");
  const dialogs = await native.dialogs(window);
  await window.getByRole("button", { name: "Allow folder" }).click();
  await dialogs.answerRestorePrompt("every-visit");
  await expect(watching.getByRole("status")).toHaveText(`Connected — ${profileB.name}`, {
    timeout: 120_000,
  });
  // "Allow on every visit" outlives B's pages: B refreshes its presence with none open.
  for (const page of extensionPages(restarted)) await page.close();
  expect(extensionPages(restarted)).toEqual([]);
  const idB = await profileIdOf(restarted);
  const expiry = () => (presenceOf(native.folder, idB) as { expiresAt: number }).expiresAt;
  const before = expiry();
  await expect.poll(expiry, { timeout: 45_000 }).toBeGreaterThan(before);
  await expect(watching.getByRole("status")).toHaveText(`Connected — ${profileB.name}`);
  restarted = await restart(restarted, watching, launch);
  await expect(watching.getByRole("status")).toHaveText(`Connected — ${profileB.name}`, {
    timeout: 120_000,
  });
  const page = await extensionPage(restarted);
  await expect(page.getByRole("status")).toHaveText(`Connected — ${profileA.name}`);
  await expect(folderSection(page)).not.toContainText("Chrome asks again");
});

/** Chooses the folder from a site tab's dashboard, through the window the banner opens. */
async function chooseFromDashboard(profile: Profile, native: Native) {
  const site = await profile.context.newPage();
  await site.goto("/");
  const dashboard = dashboardOf(site);
  await expect(dashboard.getByRole("heading", { name: "Choose the RECnRun folder" })).toBeVisible();
  const opened = profile.context.waitForEvent("page");
  await dashboard.getByRole("button", { name: "Choose folder" }).click();
  const window = await opened;
  await window.waitForLoadState();
  await expect(window.getByRole("heading", { name: "RECnRun folder" })).toBeVisible();
  await chooseFolder(window, native);
  // The window waits, open, since Chrome keeps the folder only while a page is open (H2).
  await expect(window.getByText("Keep this window open")).toBeVisible();
  return { dashboard, window };
}

test("two profiles pair from their dashboards, each in a folder window that closes once paired", async ({
  profileA,
  profileB,
  native,
}) => {
  // With the fixture's pairing pages closed, the folder window is each profile's only page.
  await profileA.pairing.close();
  await profileB.pairing.close();
  const a = await chooseFromDashboard(profileA, native);
  await expect(
    a.dashboard.getByText("Waiting for another profile in the RECnRun folder…"),
  ).toBeVisible();
  const b = await chooseFromDashboard(profileB, native);
  await expect(
    b.dashboard.getByRole("heading", { name: `Chrome — ${profileA.name} (Connected)` }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    a.dashboard.getByRole("heading", { name: `Chrome — ${profileB.name} (Connected)` }),
  ).toBeVisible();
  for (const window of [a.window, b.window])
    await expect.poll(() => window.isClosed(), { timeout: 10_000 }).toBe(true);
});

test("a profile stays unpaired when the user cancels the picker or Chrome may not edit the folder", async ({
  profileA,
  native,
}) => {
  const page = profileA.pairing;
  const dialogs = await native.dialogs(page);
  const choose = page.getByRole("button", { name: "Choose folder" });
  const aborted = page.getByRole("alert").filter({ hasText: "The user aborted a request." });
  await choose.click();
  await dialogs.cancelPicker();
  await expect(aborted).toBeVisible();
  await page.reload();
  await choose.click();
  await dialogs.chooseFolder(native.folder);
  await dialogs.answerWritePrompt("deny");
  // Chrome reports a refused write prompt as an abort too.
  await expect(aborted).toBeVisible();
  await expect(choose).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Not paired");
  expect(existsSync(join(native.folder, "pairing"))).toBe(false);
});

test("the folder window says so when Chrome refuses the folder after a restart", async ({
  profileA,
  native,
  launch,
}) => {
  await chooseFolder(profileA.pairing, native);
  await expect(folderSection(profileA.pairing)).toContainText(WAITING);
  await profileA.context.close();
  const context = await launch(profileA.dir);
  const serviceWorker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const window = await extensionPage({ context, serviceWorker }, "pairing.html#folder");
  const dialogs = await native.dialogs(window);
  await window.getByRole("button", { name: "Allow folder" }).click();
  await dialogs.answerRestorePrompt("deny");
  await expect(window.getByRole("alert")).toHaveText(
    "Chrome did not allow RECnRun to use the folder.",
  );
  await expect(window.getByRole("button", { name: "Allow folder" })).toBeEnabled();
});
