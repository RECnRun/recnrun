import type { BrowserContext } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "./fixtures/extension.ts";
import {
  allowFolder,
  chooseFolder,
  clickFolder,
  folderBanner,
  pair,
  WAITING,
} from "./fixtures/folder.ts";
import { test } from "./fixtures/native-dialogs.ts";
import type { Native } from "./fixtures/native-dialogs.ts";
import { linkStatus, pairingSection, reopen } from "./fixtures/profiles.ts";
import type { Profile } from "./fixtures/profiles.ts";
import { dashboardUrl } from "./fixtures/tabs.ts";

/*
 * Both profiles choose one real folder on the container's disk through Chrome's own picker
 * and answer its prompts (H4), each in its own dashboard.
 */

interface ChromeGlobal {
  chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
}

const profileIdOf = (profile: Pick<Profile, "serviceWorker">) =>
  profile.serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const { profileIdentity } = await chrome.storage.local.get("profileIdentity");
    return (profileIdentity as { profileId: string }).profileId;
  });

const presenceOf = (folder: string, profileId: string) =>
  JSON.parse(readFileSync(join(folder, "pairing", profileId, "presence.json"), "utf8"));

const extensionPages = (profile: Pick<Profile, "context">) =>
  profile.context.pages().filter((page) => page.url().startsWith("chrome-extension://"));

type Launch = (dir: string) => Promise<BrowserContext>;

/** Quits the profile's browser, waits until `watching` saw it go, and starts it again. */
async function restart(profile: Profile, watching: Profile, launch: Launch): Promise<Profile> {
  await profile.context.close();
  // No close message comes from a browser that quits; ICE consent checks find it gone.
  await expect(linkStatus(watching)).toHaveText(
    new RegExp(`^(Disconnected|Not reachable) — ${profile.name}$`),
    { timeout: 45_000 },
  );
  return reopen(profile, await launch(profile.dir));
}

const connected = async (a: Profile, b: Profile) => {
  await expect(linkStatus(a)).toHaveText(`Connected — ${b.name}`, { timeout: 120_000 });
  await expect(linkStatus(b)).toHaveText(`Connected — ${a.name}`, { timeout: 30_000 });
};

/**
 * Restarts `profile` and reconnects it once it allows the folder on every visit, in the restore
 * prompt (H1); `other` keeps its grant while its dashboard stays open (H2).
 */
async function restartAndAllow(profile: Profile, other: Profile, native: Native, launch: Launch) {
  const restarted = await restart(profile, other, launch);
  expect(await allowFolder(restarted, native)).toBe("restore");
  await connected(other, restarted);
  return restarted;
}

test("two profiles pair from their dashboards through one RECnRun folder on disk, with no other page", async ({
  profileA,
  profileB,
  native,
}) => {
  await pair(profileA, profileB, native);
  // The picker and its prompts came from the dashboards; RECnRun opened no page of its own.
  for (const profile of [profileA, profileB]) {
    const paths = extensionPages(profile).map((page) => new URL(page.url()).pathname);
    expect(new Set(paths)).toEqual(new Set(["/dashboard.html"]));
  }
  await expect(
    profileA.dashboard.getByRole("heading", { name: `Chrome — ${profileB.name} (Connected)` }),
  ).toBeVisible();
  // Connected, neither dashboard asks for the folder: each keeps the grant it asked for (H2).
  for (const profile of [profileA, profileB]) {
    await expect(folderBanner(profile.dashboard)).toHaveCount(0);
    // Paired, each profile stays in the folder, so its peer finds it after a restart.
    expect(presenceOf(native.folder, await profileIdOf(profile))).toMatchObject({
      displayName: profile.name,
    });
  }
});

test("the folder grant ends with the last dashboard, and allowing again keeps the folder on every visit", async ({
  profileA,
  native,
}) => {
  await chooseFolder(profileA, native);
  await expect(pairingSection(profileA.dashboard)).toContainText(WAITING);
  for (const page of extensionPages(profileA)) await page.close();
  const dashboard = await profileA.context.newPage();
  await dashboard.goto(dashboardUrl(profileA.serviceWorker));
  const reopened = { ...profileA, dashboard };
  await expect(folderBanner(dashboard)).toContainText("Allow the RECnRun folder");
  expect(await allowFolder(reopened, native)).toBe("restore");
  await expect(pairingSection(dashboard)).toContainText(WAITING);
  // On every visit, the grant outlives this dashboard too.
  await dashboard.close();
  const later = await profileA.context.newPage();
  await later.goto(dashboardUrl(profileA.serviceWorker));
  await expect(pairingSection(later)).toContainText(WAITING);
  await expect(folderBanner(later)).toHaveCount(0);
});

test("profiles that both allowed the folder on every visit keep it with no page open, reconnect with no click after a restart, and within seconds after a Disconnect", async ({
  profileA,
  profileB,
  native,
  launch,
}) => {
  test.setTimeout(480_000);
  await pair(profileA, profileB, native);
  // Each allows the folder on every visit as it restarts; after that, a restart takes no click.
  const b = await restartAndAllow(profileB, profileA, native, launch);
  const a = await restartAndAllow(profileA, b, native, launch);
  await expect(folderBanner(a.dashboard)).toHaveCount(0);
  // "Allow on every visit" outlives every extension page: B refreshes its presence with none open.
  for (const page of extensionPages(b)) await page.close();
  const idB = await profileIdOf(b);
  const expiry = () => (presenceOf(native.folder, idB) as { expiresAt: number }).expiresAt;
  const before = expiry();
  await expect.poll(expiry, { timeout: 45_000 }).toBeGreaterThan(before);
  const again = await restart(b, a, launch);
  await connected(a, again);
  await expect(folderBanner(again.dashboard)).toHaveCount(0);

  // The lower profile id offers, and its last offer is still in the folder when the other,
  // which answers, disconnects and reconnects.
  const [offerer, answerer] = (await profileIdOf(a)) < idB ? [a, again] : [again, a];
  const click = (name: string) =>
    pairingSection(answerer.dashboard).getByRole("button", { name }).click();
  await click("Disconnect");
  await expect(linkStatus(offerer)).toHaveText(`Disconnected by ${answerer.name}`);
  await click("Reconnect");
  await expect(linkStatus(answerer)).toHaveText(`Connected — ${offerer.name}`, {
    timeout: 10_000,
  });
});

test("a profile stays unpaired when the user cancels the picker or Chrome may not edit the folder", async ({
  profileA,
  native,
}) => {
  const banner = folderBanner(profileA.dashboard);
  const choose = banner.getByRole("button", { name: "Choose folder" });
  const aborted = banner.getByRole("alert").filter({ hasText: "The user aborted a request." });
  const dialogs = await clickFolder(profileA, native, "Choose folder");
  await dialogs.cancelPicker();
  await expect(aborted).toBeVisible();
  await profileA.dashboard.reload();
  await choose.click();
  await dialogs.chooseFolder(native.folder);
  await dialogs.answerWritePrompt("deny");
  // Chrome reports a refused write prompt as an abort too.
  await expect(aborted).toBeVisible();
  await expect(choose).toBeVisible();
  await expect(linkStatus(profileA)).toHaveText("Not paired");
  await expect(folderBanner(profileA.dashboard)).toContainText("Choose the RECnRun folder");
  expect(existsSync(join(native.folder, "pairing"))).toBe(false);
});

test("the dashboard says so when Chrome refuses the folder after a restart", async ({
  profileA,
  native,
  launch,
}) => {
  await chooseFolder(profileA, native);
  await expect(pairingSection(profileA.dashboard)).toContainText(WAITING);
  await profileA.context.close();
  const restarted = await reopen(profileA, await launch(profileA.dir));
  await expect(folderBanner(restarted.dashboard)).toContainText("Allow the RECnRun folder");
  const dialogs = await clickFolder(restarted, native, "Allow folder");
  await dialogs.answerRestorePrompt("deny");
  const banner = folderBanner(restarted.dashboard);
  await expect(banner.getByRole("alert")).toHaveText(
    "Chrome did not allow RECnRun to use the folder.",
  );
  await expect(banner.getByRole("button", { name: "Allow folder" })).toBeEnabled();
});

/** Removes the extension's folder grant with its trash button in Chrome's settings. */
async function revokeInSettings(profile: Pick<Profile, "context" | "serviceWorker">) {
  // URL.origin is "null" for chrome-extension: URLs.
  const origin = `chrome-extension://${new URL(profile.serviceWorker.url()).host}`;
  const settings = await profile.context.newPage();
  await settings.goto("chrome://settings/content/filesystem");
  const entry = settings.getByText(`${origin}/`);
  await expect(entry).toHaveCount(1);
  await settings.getByRole("button", { name: /remove|delete/i }).click();
  await expect(entry).toHaveCount(0);
  await settings.close();
}

test("a profile whose folder grant the user revokes in Chrome's settings allows the folder again after a restart and reconnects", async ({
  profileA,
  profileB,
  native,
  launch,
}) => {
  test.setTimeout(300_000);
  await pair(profileA, profileB, native);
  let b = await restartAndAllow(profileB, profileA, native, launch);
  await revokeInSettings(b);
  b = await restart(b, profileA, launch);
  await expect(folderBanner(b.dashboard)).toContainText("Allow the RECnRun folder", {
    timeout: 30_000,
  });
  // With the kept grant gone, Chrome shows its write prompt, not the restore prompt.
  expect(await allowFolder(b, native)).toBe("write");
  await connected(profileA, b);
});
