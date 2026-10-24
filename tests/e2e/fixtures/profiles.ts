import { chromium } from "@playwright/test";
import type { BrowserContext, Page, Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "./extension.ts";

const extensionPath = fileURLToPath(
  new URL("../../../apps/extension/.output/chrome-mv3-test", import.meta.url),
);

/** One Chrome profile: its own user-data directory, extension, and pairing page. */
export interface Profile {
  name: string;
  context: BrowserContext;
  serviceWorker: Worker;
  pairing: Page;
}

interface ProfileFixtures {
  /** The default context, named and with its pairing page open. */
  home: Profile;
  /** A second profile in a second Chromium, as a second Chrome profile runs. */
  work: Profile;
}

interface FramesGlobal {
  recnrunPeerFrames?: string[];
}

const workerOf = async (context: BrowserContext) =>
  context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));

async function openPairing(context: BrowserContext, serviceWorker: Worker, name: string) {
  const pairing = await context.newPage();
  await pairing.goto(new URL("pairing.html", serviceWorker.url()).href);
  const field = pairing.getByRole("textbox", { name: "Name" });
  await field.fill(name);
  await pairing.getByRole("button", { name: "Save name" }).click();
  await expect(pairing.getByText(/^Profile id /)).toBeVisible();
  return pairing;
}

export const test = base.extend<ProfileFixtures>({
  home: async ({ context, serviceWorker }, use) => {
    const pairing = await openPairing(context, serviceWorker, "Home");
    await use({ name: "Home", context, serviceWorker, pairing });
  },
  work: async ({ headless }, use) => {
    // An empty user-data directory gives Playwright a fresh temporary profile, never a real one.
    const context = await chromium.launchPersistentContext("", {
      headless,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    const serviceWorker = await workerOf(context);
    const pairing = await openPairing(context, serviceWorker, "Work");
    await use({ name: "Work", context, serviceWorker, pairing });
    await context.close();
  },
});

const codeBox = (page: Page, label: string) =>
  page.getByRole("textbox", { name: label, exact: true });

/** Pastes a code into a pairing page and returns the digits it shows for it. */
async function importCode(page: Page, code: string): Promise<string> {
  await page.getByRole("textbox", { name: "Code from the other profile" }).fill(code);
  await page.getByRole("button", { name: "Import code" }).click();
  const digits = page.getByLabel("Pairing digits");
  await expect(digits).toHaveText(/^\d{6}$/);
  return (await digits.textContent()) ?? "";
}

export const linkStatus = (profile: Profile) =>
  profile.pairing.getByRole("status", { name: "Link status" });

/** The manual pairing a user does: offer, answer, the same digits on both sides, then connect. */
export async function pair(offerer: Profile, answerer: Profile) {
  await offerer.pairing.getByRole("button", { name: "Create offer" }).click();
  const offer = await codeBox(offerer.pairing, "Offer").inputValue();
  const answererDigits = await importCode(answerer.pairing, offer);
  await answerer.pairing.getByRole("button", { name: "Accept and create answer" }).click();
  const answer = await codeBox(answerer.pairing, "Answer").inputValue();
  const offererDigits = await importCode(offerer.pairing, answer);
  await offerer.pairing.getByRole("button", { name: "Confirm and connect" }).click();
  await expect(linkStatus(offerer)).toHaveText(`Connected — ${answerer.name}`);
  await expect(linkStatus(answerer)).toHaveText(`Connected — ${offerer.name}`);
  for (const profile of [offerer, answerer])
    await expect(profile.pairing.getByRole("alert")).toHaveCount(0);
  return { offer, answer, offererDigits, answererDigits };
}

/** Every frame a profile's background received over the link, as the test build records them. */
export const receivedFrames = (profile: Profile) =>
  profile.serviceWorker.evaluate(() => (globalThis as FramesGlobal).recnrunPeerFrames ?? []);

/** Sends a peer request from an extension page, as the dashboards do. */
export function askPeer(profile: Profile, request: { type: string; [key: string]: unknown }) {
  return profile.pairing.evaluate(
    (message) =>
      (
        globalThis as unknown as {
          chrome: { runtime: { sendMessage(m: object): Promise<unknown> } };
        }
      ).chrome.runtime.sendMessage({ target: "background", ...message }),
    request,
  ) as Promise<{ ok: boolean; result?: unknown; error?: string }>;
}
