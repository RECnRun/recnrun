import type { Page } from "@playwright/test";
import type { PwaAnswer, PwaFirst, PwaReady } from "../apps/pwa-pages.ts";
import { appLog } from "./app.ts";
import { APP } from "./workspace.ts";

/** The installable fixture app's page for `run`. */
export const pwaUrl = (run: string) => `${APP}/pwa/?run=${encodeURIComponent(run)}`;

// Node may not resolve *.localhost, so specs reach the server through plain localhost.
const CONTROL = "http://localhost:5192/pwa/control";

interface PwaWindow {
  __pwa?: {
    first?: PwaFirst;
    ready?: PwaReady;
    failure?: string;
    signIn: (user: string) => Promise<void>;
    ask: () => Promise<PwaAnswer>;
    update: () => Promise<string>;
  };
}

/** Sets the server's app version or offline switch for `run`. */
export async function pwaServer(run: string, change: { version?: number; offline?: boolean }) {
  const response = await fetch(`${CONTROL}?run=${encodeURIComponent(run)}`, {
    method: "POST",
    body: JSON.stringify(change),
  });
  if (!response.ok) throw new Error(`The PWA control answered ${response.status}.`);
}

/** What the page read first, and its registration once a worker controls it. */
export async function pwaLoaded(page: Page): Promise<{ first: PwaFirst; ready: PwaReady }> {
  const handle = await page.waitForFunction(() => {
    const pwa = (window as PwaWindow).__pwa;
    if (pwa?.failure !== undefined) return { failure: pwa.failure };
    return pwa?.first && pwa.ready ? { first: pwa.first, ready: pwa.ready } : undefined;
  });
  const loaded = (await handle.jsonValue()) as
    | { failure: string }
    | { first: PwaFirst; ready: PwaReady };
  if ("failure" in loaded) throw new Error(`The PWA failed: ${loaded.failure}`);
  return loaded;
}

/** Signs `user` in: the HttpOnly session cookie, the localStorage profile, the IndexedDB profile. */
export const pwaSignIn = (page: Page, user: string) =>
  page.evaluate((name) => (window as PwaWindow).__pwa?.signIn(name), user);

/** Asks the controlling worker who is signed in; it fetches the API itself. */
export async function pwaAsk(page: Page): Promise<PwaAnswer> {
  const answer = await page.evaluate(() => (window as PwaWindow).__pwa?.ask());
  if (!answer) throw new Error("The PWA page has no worker to ask.");
  return answer;
}

/** Checks for a new worker and waits until it controls the page; resolves with its script URL. */
export const pwaUpdate = async (page: Page) =>
  (await page.evaluate(() => (window as PwaWindow).__pwa?.update())) ?? "";

/** The server's log of every `/pwa/api/me` request of `run`, with the cookie names it carried. */
export const pwaApiCalls = async (run: string) =>
  (await appLog(run)).filter(({ path }) => path === "/pwa/api/me");
