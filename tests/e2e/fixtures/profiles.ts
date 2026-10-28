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
  /** The extension's pairing page in this profile. */
  pairing: Page;
}

interface ProfileFixtures {
  profileA: Profile;
  profileB: Profile;
  /** Opens a new browser process on a profile's directory, as after a restart. */
  launch: (dir: string) => Promise<BrowserContext>;
}

async function launchProfile(dir: string, headless: boolean): Promise<BrowserContext> {
  return chromium.launchPersistentContext(dir, {
    headless,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
}

async function openProfile(name: string, headless: boolean): Promise<Profile> {
  const dir = mkdtempSync(join(tmpdir(), `recnrun-profile-${name.toLowerCase()}-`));
  const context = await launchProfile(dir, headless);
  const [running] = context.serviceWorkers();
  const serviceWorker = running ?? (await context.waitForEvent("serviceworker"));
  const pairing = await context.newPage();
  await pairing.goto(`chrome-extension://${new URL(serviceWorker.url()).host}/pairing.html`);
  await pairing.getByLabel("Name").fill(name);
  await pairing.getByRole("button", { name: "Save name" }).click();
  await expect(pairing.getByRole("status")).toHaveText("Not paired");
  return { name, dir, context, serviceWorker, pairing };
}

async function closeProfile(profile: Profile) {
  await profile.context.close().catch(() => {});
  rmSync(profile.dir, { recursive: true, force: true });
}

/**
 * Two independent Chrome profiles, each a persistent context of its own on its own temporary
 * user data directory, never `browser.newContext()`, and never the user's own profile.
 */
export const test = base.extend<ProfileFixtures>({
  profileA: async ({ headless }, use) => {
    const profile = await openProfile("Profile A", headless);
    await use(profile);
    await closeProfile(profile);
  },
  profileB: async ({ headless }, use) => {
    const profile = await openProfile("Profile B", headless);
    await use(profile);
    await closeProfile(profile);
  },
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

const codeOf = (page: Page, label: string) => page.getByLabel(label, { exact: true }).inputValue();

/** Pastes a code, imports it, and returns the six digits the page shows for it. */
async function importCode(page: Page, code: string): Promise<string> {
  await page.getByLabel("Code from the other profile").fill(code);
  await page.getByRole("button", { name: "Import code" }).click();
  return page
    .getByRole("definition")
    .filter({ hasText: /^\d{6}$/ })
    .innerText();
}

/** Unfolds the manual steps, which the page keeps under the folder. */
async function byHand(page: Page) {
  const details = page.locator("details", { hasText: "Pair by hand instead" });
  if ((await details.getAttribute("open")) === null) await details.locator("summary").click();
}

/** The manual pairing, as two users do it: offer in A, accept in B, confirm in A. */
export async function pair(a: Profile, b: Profile): Promise<string> {
  await byHand(a.pairing);
  await byHand(b.pairing);
  await a.pairing.getByRole("button", { name: "Create offer" }).click();
  const offer = await codeOf(a.pairing, "Offer");
  const digitsB = await importCode(b.pairing, offer);
  await expect(b.pairing.getByLabel("Pairing check")).toContainText(a.name);
  await b.pairing.getByRole("button", { name: "Accept and create answer" }).click();
  const answer = await codeOf(b.pairing, "Answer");
  const digitsA = await importCode(a.pairing, answer);
  expect(digitsA).toBe(digitsB);
  await a.pairing.getByRole("button", { name: "Confirm and connect" }).click();
  await expect(a.pairing.getByRole("status")).toHaveText(`Connected — ${b.name}`);
  await expect(b.pairing.getByRole("status")).toHaveText(`Connected — ${a.name}`);
  return digitsA;
}

interface PeerGlobal {
  recnrunPeerFrames: string[];
}

/** Every frame the profile's background sent or received over the link, in the test build. */
export const framesOf = (profile: Profile): Promise<string[]> =>
  profile.serviceWorker.evaluate(() => (globalThis as unknown as PeerGlobal).recnrunPeerFrames);

/** A dashboard tab of its own in a profile, beside the one RECnRun opened as it was installed. */
export async function dashboardIn(profile: Profile): Promise<Page> {
  const dashboard = await profile.context.newPage();
  await dashboard.goto(dashboardUrl(profile.serviceWorker));
  return dashboard;
}
