import type { Page } from "@playwright/test";
import { expect } from "./extension.ts";
import type { Native } from "./native-dialogs.ts";
import { linkStatus, pairingSection, peerStatus } from "./profiles.ts";
import type { Profile } from "./profiles.ts";

/*
 * Every profile pairs from its dashboard, through one real folder on the container's disk and
 * Chrome's own picker and prompts (H4), which the dashboard shows itself and whose grant it holds
 * while open (H2). Its own module, since native-dialogs.ts extends the profiles fixture.
 */

export const WAITING = "Waiting for another profile in the RECnRun folder…";

export const folderBanner = (dashboard: Page) =>
  dashboard.locator('section[aria-labelledby="folder-banner-heading"]');

/** Clicks the dashboard's folder button named `name`; returns the dialogs Chrome shows for it. */
export async function clickFolder(profile: Profile, native: Native, name: string) {
  const dialogs = await native.dialogs(profile.dashboard);
  await profile.dashboard.getByRole("button", { name }).click();
  return dialogs;
}

/** Chooses the folder in the profile's dashboard, which then holds the grant (H2). */
export async function chooseFolder(profile: Profile, native: Native): Promise<void> {
  const dialogs = await clickFolder(profile, native, "Choose folder");
  await dialogs.chooseFolder(native.folder);
  await dialogs.answerWritePrompt("allow");
  await expect(folderBanner(profile.dashboard)).toHaveCount(0);
}

/**
 * Allows the folder chosen before, from the dashboard's banner; says which prompt Chrome asked
 * with: its restore prompt, answered "Allow on every visit", or its write prompt.
 */
export async function allowFolder(profile: Profile, native: Native) {
  const dialogs = await clickFolder(profile, native, "Allow folder");
  return dialogs.allowInEitherPrompt();
}

/** Pairs two profiles, each choosing the folder in its own dashboard. */
export async function pair(a: Profile, b: Profile, native: Native): Promise<void> {
  await chooseFolder(a, native);
  await expect(pairingSection(a.dashboard)).toContainText(WAITING);
  await chooseFolder(b, native);
  await expect(linkStatus(a)).toHaveText(`Connected — ${b.name}`, { timeout: 30_000 });
  await expect(linkStatus(b)).toHaveText(`Connected — ${a.name}`);
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
