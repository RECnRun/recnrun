import type { Page } from "@playwright/test";
import { expect } from "./extension.ts";
import type { Native } from "./native-dialogs.ts";
import { linkStatus, pairingSection, peerStatus } from "./profiles.ts";
import type { Profile } from "./profiles.ts";

/*
 * Every profile pairs from its dashboard, through one real folder on the container's disk and
 * Chrome's own picker and prompts (H4), so the files one profile writes are the ones the other
 * reads. Its own module, since native-dialogs.ts extends the profiles fixture.
 */

export const WAITING = "Waiting for another profile in the RECnRun folder…";

export const folderBanner = (dashboard: Page) =>
  dashboard.locator('section[aria-labelledby="folder-banner-heading"]');

/** Clicks the dashboard's folder banner; returns the window it opens and its dialogs. */
export async function openFolderWindow(profile: Profile, native: Native) {
  const opened = profile.context.waitForEvent("page");
  await folderBanner(profile.dashboard).getByRole("button").click();
  const window = await opened;
  await window.waitForLoadState();
  await expect(window.getByRole("heading", { name: "RECnRun folder" })).toBeVisible();
  return { window, dialogs: await native.dialogs(window) };
}

/** Chooses the folder in the profile's folder window, which then waits, open (H2). */
export async function chooseFolder(profile: Profile, native: Native): Promise<Page> {
  const { window, dialogs } = await openFolderWindow(profile, native);
  await window.getByRole("button", { name: "Choose folder" }).click();
  await dialogs.chooseFolder(native.folder);
  await dialogs.answerWritePrompt("allow");
  await expect(window.getByText("Keep this window open")).toBeVisible();
  return window;
}

/**
 * Allows the folder chosen before, from the banner's window; says which prompt Chrome asked
 * with: its restore prompt, answered "Allow on every visit", or its write prompt.
 */
export async function allowFolder(profile: Profile, native: Native) {
  const { window, dialogs } = await openFolderWindow(profile, native);
  await window.getByRole("button", { name: "Allow folder" }).click();
  return dialogs.allowInEitherPrompt();
}

/** Pairs two profiles from their dashboards; returns their folder windows, which close. */
export async function pair(a: Profile, b: Profile, native: Native): Promise<Page[]> {
  const windowA = await chooseFolder(a, native);
  await expect(pairingSection(a.dashboard)).toContainText(WAITING);
  const windowB = await chooseFolder(b, native);
  await expect(linkStatus(a)).toHaveText(`Connected — ${b.name}`, { timeout: 30_000 });
  await expect(linkStatus(b)).toHaveText(`Connected — ${a.name}`);
  return [windowA, windowB];
}

/**
 * Pairs every profile with every other, one newcomer at a time, as a user adds profiles: the
 * linked profiles' dashboards keep the folder grant (H2), so they find each newcomer there.
 */
export async function pairAll(profiles: Profile[], native: Native): Promise<void> {
  const [first, second, ...rest] = profiles;
  if (!first || !second) throw new Error("Pairing takes two profiles.");
  await pair(first, second, native);
  const joined = [first, second];
  for (const next of rest) {
    await chooseFolder(next, native);
    for (const member of joined) {
      await expect(peerStatus(member, next)).toHaveText(`Connected — ${next.name}`, {
        timeout: 30_000,
      });
      await expect(peerStatus(next, member)).toHaveText(`Connected — ${member.name}`);
    }
    joined.push(next);
  }
}
