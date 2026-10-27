import type { BrowserContext } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "./fixtures/extension.ts";
import {
  allowFolder,
  chooseFolder,
  folderBanner,
  openFolderWindow,
  pair,
  WAITING,
} from "./fixtures/folder.ts";
import { test } from "./fixtures/native-dialogs.ts";
import type { Native } from "./fixtures/native-dialogs.ts";
import { linkStatus, pairingSection, reopen } from "./fixtures/profiles.ts";
import type { Profile } from "./fixtures/profiles.ts";

/*
 * Both profiles choose one real folder on the container's disk through Chrome's own picker
 * and answer its prompts (H4), from the window each dashboard's folder banner opens.
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
 * Restarts `profile` and reconnects it: `other` allows the folder again, since its grant ended
 * with its folder window (H2), and `profile` on every visit, in the restore prompt (H1).
 */
async function restartAndAllow(profile: Profile, other: Profile, native: Native, launch: Launch) {
  const restarted = await restart(profile, other, launch);
  await allowFolder(other, native);
  expect(await allowFolder(restarted, native)).toBe("restore");
  await connected(other, restarted);
  return restarted;
}

test("two profiles pair from their dashboards through one RECnRun folder on disk, in windows that close once paired", async ({
  profileA,
  profileB,
  native,
}) => {
  const windows = await pair(profileA, profileB, native);
  for (const window of windows)
    await expect.poll(() => window.isClosed(), { timeout: 10_000 }).toBe(true);
  await expect(
    profileA.dashboard.getByRole("heading", { name: `Chrome — ${profileB.name} (Connected)` }),
  ).toBeVisible();
  // Connected, neither dashboard asks for the folder, though Chrome dropped the grant (H2).
  for (const profile of [profileA, profileB]) {
    await expect(folderBanner(profile.dashboard)).toHaveCount(0);
    // Paired, each profile stays in the folder, so its peer finds it after a restart.
    expect(presenceOf(native.folder, await profileIdOf(profile))).toMatchObject({
      displayName: profile.name,
    });
  }
});

test("profiles that both allowed the folder on every visit keep it with no page open, and reconnect with no click after a restart", async ({
  profileA,
  profileB,
  native,
  launch,
}) => {
  test.setTimeout(480_000);
  await pair(profileA, profileB, native);
  // Chrome offers "Allow on every visit" only after a restart, so each profile restarts once.
  const b = await restartAndAllow(profileB, profileA, native, launch);
  // B keeps its folder now, so only A allows it after its own restart.
  const a = await restart(profileA, b, launch);
  await expect(folderBanner(b.dashboard)).toHaveCount(0);
  expect(await allowFolder(a, native)).toBe("restore");
  await connected(b, a);
  // "Allow on every visit" outlives the folder windows: B refreshes its presence with none open.
  await expect.poll(() => extensionPages(b), { timeout: 15_000 }).toEqual([]);
  const idB = await profileIdOf(b);
  const expiry = () => (presenceOf(native.folder, idB) as { expiresAt: number }).expiresAt;
  const before = expiry();
  await expect.poll(expiry, { timeout: 45_000 }).toBeGreaterThan(before);
  const again = await restart(b, a, launch);
  await connected(a, again);
  expect(extensionPages(again)).toEqual([]);
});

test("a profile stays unpaired when the user cancels the picker or Chrome may not edit the folder", async ({
  profileA,
  native,
}) => {
  const { window, dialogs } = await openFolderWindow(profileA, native);
  const choose = window.getByRole("button", { name: "Choose folder" });
  const aborted = window.getByRole("alert").filter({ hasText: "The user aborted a request." });
  await choose.click();
  await dialogs.cancelPicker();
  await expect(aborted).toBeVisible();
  await window.reload();
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

test("the folder window says so when Chrome refuses the folder after a restart", async ({
  profileA,
  native,
  launch,
}) => {
  await chooseFolder(profileA, native);
  await expect(pairingSection(profileA.dashboard)).toContainText(WAITING);
  await profileA.context.close();
  const restarted = await reopen(profileA, await launch(profileA.dir));
  await expect(folderBanner(restarted.dashboard)).toContainText("Allow the RECnRun folder");
  const { window, dialogs } = await openFolderWindow(restarted, native);
  await window.getByRole("button", { name: "Allow folder" }).click();
  await dialogs.answerRestorePrompt("deny");
  await expect(window.getByRole("alert")).toHaveText(
    "Chrome did not allow RECnRun to use the folder.",
  );
  await expect(window.getByRole("button", { name: "Allow folder" })).toBeEnabled();
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
  await allowFolder(profileA, native);
  // With the kept grant gone, Chrome shows its write prompt, not the restore prompt.
  expect(await allowFolder(b, native)).toBe("write");
  await connected(profileA, b);
});
