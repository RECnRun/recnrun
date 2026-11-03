import { expect } from "@playwright/test";
import type { Worker } from "@playwright/test";
import { test as nativeTest } from "../../e2e/fixtures/native-dialogs.ts";
import { linkStatus, pairingSection } from "../../e2e/fixtures/profiles.ts";
import type { Profile } from "../../e2e/fixtures/profiles.ts";
import { dashboardUrl } from "../../e2e/fixtures/tabs.ts";
import { EXTENSION_PATH, loadUnpacked } from "./extension-loaders.ts";

/*
 * The mesh regression on the branded browser: each profile is Google Chrome Stable on a throwaway
 * root of its own, the test build installed with `Extensions.loadUnpacked` (label `diagnostic`),
 * driven by Playwright over CDP, and paired with tests/e2e's folder steps and native dialogs.
 */

export interface ChromeProfile extends Profile {
  /** `google-chrome --version` of the browser this profile runs in. */
  version: string;
}

interface ChromeGlobal {
  chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
}

/** The name the profile's background stored, which its peers see. */
const displayNameOf = (worker: Worker) =>
  worker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const { profileIdentity } = await chrome.storage.local.get("profileIdentity");
    return (profileIdentity as { displayName: string } | undefined)?.displayName;
  });

async function workerOf(profile: { context: Profile["context"] }, id: string): Promise<Worker> {
  const ours = (worker: Worker) => worker.url().startsWith(`chrome-extension://${id}/`);
  const running = profile.context.serviceWorkers().find(ours);
  return running ?? (await profile.context.waitForEvent("serviceworker", { predicate: ours }));
}

/** Opens a named profile beside a page of the website, as tests/e2e's `openProfile` does. */
async function openChromeProfile(name: string, baseURL: string) {
  const loaded = await loadUnpacked(EXTENSION_PATH);
  try {
    const [context] = loaded.chrome.browser.contexts();
    if (!context) throw new Error("Chrome has no default context.");
    const serviceWorker = await workerOf({ context }, loaded.extensionId);
    const site = await context.newPage();
    await site.goto(new URL(`/privacy/?${encodeURIComponent(name)}`, baseURL).href);
    const dashboard = await context.newPage();
    await dashboard.goto(dashboardUrl(serviceWorker));
    const dir = loaded.chrome.userDataDir;
    const profile = { name, dir, context, serviceWorker, site, dashboard };
    await expect(linkStatus(profile)).toHaveText("Not paired");
    await pairingSection(dashboard).getByLabel("This profile").fill(name);
    await dashboard.getByRole("button", { name: "Save name" }).click();
    await expect.poll(() => displayNameOf(serviceWorker)).toBe(name);
    const chromeProfile: ChromeProfile = { ...profile, version: loaded.chrome.version };
    return { profile: chromeProfile, close: () => loaded.close() };
  } catch (error) {
    await loaded.close();
    throw error;
  }
}

const chromeProfileNamed =
  (name: string) =>
  async (
    { baseURL }: { baseURL: string | undefined },
    use: (profile: ChromeProfile) => Promise<void>,
  ) => {
    if (!baseURL) throw new Error("Set use.baseURL to the website preview.");
    const { profile, close } = await openChromeProfile(name, baseURL);
    await use(profile);
    await close();
  };

/** Two Google Chrome profiles, plus tests/e2e's `native` dialogs and folder. */
export const test = nativeTest.extend<{ chromeA: ChromeProfile; chromeB: ChromeProfile }>({
  chromeA: chromeProfileNamed("Profile A"),
  chromeB: chromeProfileNamed("Profile B"),
});

export { expect };
