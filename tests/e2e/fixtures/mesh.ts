import type { Locator, Page } from "@playwright/test";
import { expect } from "./extension.ts";
import { peerLine, peerStatus } from "./profiles.ts";
import type { Profile } from "./profiles.ts";
import { clickToOpenPanel } from "./session.ts";
import { storedSession } from "./tabs.ts";

/*
 * The mesh regressions of five linked profiles, shared by every transport that links them: the
 * folder of tests/e2e and the Downloads of tests/browser/mesh-downloads.spec.ts.
 */

/** A tab of the profile's own, at an address that names it; the privacy policy has no frame. */
export async function openIn(profile: Profile, baseURL?: string): Promise<Page> {
  const page = await profile.context.newPage();
  const path = `/privacy/?${profile.name.replace(" ", "-")}`;
  // A context Playwright did not create, as over connectOverCDP, has no base URL of its own.
  await page.goto(baseURL ? new URL(path, baseURL).href : path);
  return page;
}

/** The profile's list of `other`'s tabs, as its dashboard heads it. */
export const listOf = (profile: Profile, other: Profile, state = "Connected") =>
  profile.dashboard.getByRole("complementary", { name: `Chrome — ${other.name} (${state})` });

export const tabIn = (list: ReturnType<typeof listOf>, url: string) =>
  list.getByRole("listitem").filter({ hasText: url });

const clickLine = (profile: Profile, other: Profile, name: string) =>
  peerLine(profile, other).getByRole("button", { name }).click();

/** Every pair of `profiles`, each way round. */
export const pairsOf = (profiles: Profile[]): [Profile, Profile][] =>
  profiles.flatMap((one) =>
    profiles.filter((other) => other !== one).map((other): [Profile, Profile] => [one, other]),
  );

export async function expectConnected(pairs: [Profile, Profile][]) {
  for (const [one, other] of pairs)
    await expect(peerStatus(one, other)).toHaveText(`Connected — ${other.name}`);
}

/** Each profile lists, under each other profile's name, the tab that profile opened. */
export async function expectEveryTabListed(profiles: Profile[], baseURL?: string) {
  const opened = async (each: Profile) => [each, (await openIn(each, baseURL)).url()] as const;
  const urls = new Map(await Promise.all(profiles.map(opened)));
  for (const [one, other] of pairsOf(profiles))
    await expect(tabIn(listOf(one, other), urls.get(other) ?? "")).toBeVisible();
}

/**
 * Disconnect ends the first pair only and Reconnect links it again; then the last profile quits
 * through `quit`, and every other one sees it go while their own links stay.
 */
export async function disconnectThenQuit(
  all: Profile[],
  quit: (profile: Profile) => Promise<void>,
) {
  const [profileA, profileB] = all;
  const last = all.at(-1);
  if (!profileA || !profileB || !last) throw new Error("The regression takes several profiles.");
  await clickLine(profileA, profileB, "Disconnect");
  await expect(peerStatus(profileA, profileB)).toHaveText(`Disconnected — ${profileB.name}`);
  await expect(peerStatus(profileB, profileA)).toHaveText(`Disconnected by ${profileA.name}`);
  await expectConnected(
    pairsOf(all).filter((pair) => !pair.includes(profileA) || !pair.includes(profileB)),
  );
  await clickLine(profileA, profileB, "Reconnect");
  await expect(peerStatus(profileA, profileB)).toHaveText(`Connected — ${profileB.name}`, {
    timeout: 30_000,
  });
  await expect(peerStatus(profileB, profileA)).toHaveText(`Connected — ${profileA.name}`);

  await quit(last);
  const rest = all.slice(0, -1);
  // No close message comes from a browser that quits; its heartbeats stop.
  for (const profile of rest) {
    await expect(peerStatus(profile, last)).toHaveText(
      new RegExp(`^(Disconnected|Not reachable) — ${last.name}$`),
      { timeout: 5_000 },
    );
  }
  await expectConnected(pairsOf(rest));
}

/**
 * The first profile starts a session in the third one's tab; the others' own lists and their lists
 * of the four others say so, and none offers Record. Answers the tab the session records.
 */
export async function sessionBlocksRecord(all: Profile[], baseURL?: string): Promise<Page> {
  const [from, , runner, ...watchers] = all;
  const second = all[1];
  if (!from || !second || !runner) throw new Error("The regression takes several profiles.");
  const inRunner = await openIn(runner, baseURL);
  const records = (dashboard: Page | Locator) => dashboard.getByRole("button", { name: "Record" });
  const record = records(tabIn(listOf(from, runner), inRunner.url()));
  await clickToOpenPanel(from.context, record);
  await expect
    .poll(() => storedSession(runner.serviceWorker))
    .toMatchObject({ status: "recording" });
  for (const profile of [second, ...watchers]) {
    await expect(records(profile.dashboard)).toHaveCount(0);
    await expect(profile.dashboard.getByText(`Recording in ${runner.name}`)).toHaveCount(
      all.length,
    );
  }
  return inRunner;
}
