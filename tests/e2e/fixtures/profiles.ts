import { chromium, test as base } from "@playwright/test";
import type { BrowserContext, Page, Worker } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "./extension.ts";
import { dashboardUrl } from "./tabs.ts";

const extensionPath = fileURLToPath(
  new URL("../../../apps/extension/.output/chrome-mv3-test", import.meta.url),
);

/** One Chrome profile: its own user data directory, browser process, and extension install. */
export interface Profile {
  name: string;
  dir: string;
  context: BrowserContext;
  serviceWorker: Worker;
  /** A tab of this profile at an address of its own, and a dashboard tab beside it. */
  site: Page;
  dashboard: Page;
}

interface ProfileFixtures {
  profileA: Profile;
  profileB: Profile;
  /** Three more profiles, for a mesh of five. */
  profileC: Profile;
  profileD: Profile;
  profileE: Profile;
  /** Opens a new browser process on a profile's directory, as after a restart. */
  launch: (dir: string) => Promise<BrowserContext>;
}

async function launchProfile(dir: string, headless: boolean): Promise<BrowserContext> {
  return chromium.launchPersistentContext(dir, {
    headless,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
}

/** The dashboard's pairing section: the link in words, this profile's name, and its actions. */
export const pairingSection = (dashboard: Page) =>
  dashboard.locator('section[aria-labelledby="pairing-heading"]');

export const linkStatus = (profile: Pick<Profile, "dashboard">) =>
  pairingSection(profile.dashboard).getByRole("status");

/** The pairing section's line about `other`, in a profile paired with several. */
export const peerLine = (profile: Pick<Profile, "dashboard">, other: Pick<Profile, "name">) =>
  pairingSection(profile.dashboard)
    .getByRole("listitem")
    .filter({ hasText: `Forget ${other.name}` });

/** How `profile`'s link to `other` stands, in words. */
export const peerStatus = (profile: Pick<Profile, "dashboard">, other: Pick<Profile, "name">) =>
  peerLine(profile, other).getByRole("status");

/** The profile on a browser just started on its directory, with a tab and a dashboard of its own. */
export async function reopen(
  profile: Pick<Profile, "name" | "dir">,
  context: BrowserContext,
): Promise<Profile> {
  const [running] = context.serviceWorkers();
  const serviceWorker = running ?? (await context.waitForEvent("serviceworker"));
  // The privacy policy runs no RECnRun script, so the tab stands in for the user's own application.
  const site = await context.newPage();
  await site.goto(`/privacy/?${encodeURIComponent(profile.name)}`);
  const dashboard = await context.newPage();
  await dashboard.goto(dashboardUrl(serviceWorker));
  return { ...profile, context, serviceWorker, site, dashboard };
}

interface ChromeGlobal {
  chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
}

const displayNameOf = (worker: Worker) =>
  worker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const { profileIdentity } = await chrome.storage.local.get("profileIdentity");
    return (profileIdentity as { displayName: string } | undefined)?.displayName;
  });

async function openProfile(name: string, headless: boolean): Promise<Profile> {
  const dir = mkdtempSync(join(tmpdir(), `recnrun-profile-${name.toLowerCase()}-`));
  const profile = await reopen({ name, dir }, await launchProfile(dir, headless));
  await expect(linkStatus(profile)).toHaveText("Not paired");
  await pairingSection(profile.dashboard).getByLabel("This profile").fill(name);
  await profile.dashboard.getByRole("button", { name: "Save name" }).click();
  await expect.poll(() => displayNameOf(profile.serviceWorker)).toBe(name);
  return profile;
}

async function closeProfile(profile: Profile) {
  await profile.context.close().catch(() => {});
  rmSync(profile.dir, { recursive: true, force: true });
}

/** A fixture that opens the profile named `name` for a test and removes it after. */
const profileNamed =
  (name: string) =>
  async ({ headless }: { headless: boolean }, use: (profile: Profile) => Promise<void>) => {
    const profile = await openProfile(name, headless);
    await use(profile);
    await closeProfile(profile);
  };

/**
 * Independent Chrome profiles, each a persistent context of its own on its own temporary
 * user data directory, never `browser.newContext()`, and never the user's own profile.
 */
export const test = base.extend<ProfileFixtures>({
  profileA: profileNamed("Profile A"),
  profileB: profileNamed("Profile B"),
  profileC: profileNamed("Profile C"),
  profileD: profileNamed("Profile D"),
  profileE: profileNamed("Profile E"),
  launch: async ({ headless }, use) => {
    const opened: BrowserContext[] = [];
    await use(async (dir) => {
      const context = await launchProfile(dir, headless);
      opened.push(context);
      return context;
    });
    for (const context of opened) await context.close().catch(() => {});
  },
});

interface PeerGlobal {
  recnrunPeerFrames: string[];
}

/** Every frame the profile's background sent or received over the link, in the test build. */
export const framesOf = (profile: Profile): Promise<string[]> =>
  profile.serviceWorker.evaluate(() => (globalThis as unknown as PeerGlobal).recnrunPeerFrames);

interface RuntimeGlobal {
  chrome: {
    storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
    runtime: { sendMessage(message: unknown): Promise<unknown> };
  };
}

/** Sends a raw frame over the link to `peer` from a profile's background, as a faulty peer would. */
export const sendRaw = (profile: Profile, peer: string, frame: string) =>
  profile.serviceWorker.evaluate(
    ([to, raw]) =>
      (globalThis as unknown as RuntimeGlobal).chrome.runtime.sendMessage({
        target: "offscreen",
        command: { type: "send", peer: to, frame: raw },
      }),
    [peer, frame] as const,
  );

/** The profile's own id, as its peers know it. */
export const profileIdOf = (profile: Profile): Promise<string> =>
  profile.serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as RuntimeGlobal;
    const { profileIdentity } = await chrome.storage.local.get("profileIdentity");
    return (profileIdentity as { profileId: string }).profileId;
  });
