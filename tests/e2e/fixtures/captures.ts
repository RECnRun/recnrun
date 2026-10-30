import type { BrowserContext, Page, Worker } from "@playwright/test";
import { expect } from "./extension.ts";
import { incognitoWindows, startWithIdentity } from "./identity.ts";
import { APP, pageAt } from "./workspace.ts";

/** A page of the fixture app that reads and writes nothing by itself. */
export const BLANK = `${APP}/blank`;

const EMPTY = { cookies: [], site: { localStorage: {}, sessionStorage: {}, indexedDB: [] } };

/** Opens the managed window at the blank page with nothing restored, as a first session would. */
export async function openBlank(context: BrowserContext, serviceWorker: Worker): Promise<Page> {
  await startWithIdentity(serviceWorker, BLANK, EMPTY);
  return pageAt(context, BLANK);
}

/** Closes the managed tab and waits until Chrome lists no Incognito window. */
export async function closeWorkspace(serviceWorker: Worker, page: Page): Promise<void> {
  await page.close();
  await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
}
