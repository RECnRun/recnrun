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

/** Clicks the dashboard's folder banner, or `button`; returns the window it opens and its dialogs. */
export async function openFolderWindow(
  profile: Profile,
  native: Native,
  button = folderBanner(profile.dashboard).getByRole("button"),
) {
  const opened = profile.context.waitForEvent("page");
  await button.click();
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
 * Lets a newcomer pair with a linked profile, whose folder grant ended with its window (H2). Its
 * links keep handles to the folder, so Chrome mostly asks with its write prompt; the window then
 * waits until the newcomer pairs.
 */
export async function letJoin(profile: Profile, native: Native): Promise<Page> {
  const join = pairingSection(profile.dashboard).getByRole("button", {
    name: "Let another profile join",
  });
  const { window, dialogs } = await openFolderWindow(profile, native, join);
  await window.getByRole("button", { name: "Allow folder" }).click();
  await dialogs.allowInEitherPrompt();
  await expect(window.getByText("Keep this window open")).toBeVisible();
  return window;
}

/** Pairs every profile with every other, one newcomer at a time, as a user adds profiles. */
export async function pairAll(profiles: Profile[], native: Native): Promise<void> {
  const [first, second, ...rest] = profiles;
  if (!first || !second) throw new Error("Pairing takes two profiles.");
  await pair(first, second, native);
  const joined = [first, second];
  for (const next of rest) {
    for (const member of joined) await letJoin(member, native);
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
