import type { Page } from "@playwright/test";
import type { Inspected } from "../apps/pages.ts";
import { expect } from "./extension.ts";

// Node may not resolve *.localhost, so specs reach the server log through plain localhost.
export const LOG = "http://localhost:5192/__log";

interface FixtureWindow {
  __sentinelDone?: boolean;
  __sentinelError?: string;
  __inspected?: Inspected;
}

/** What `/inspect` reads on an origin that holds nothing at all. */
export const NOTHING: Inspected = {
  cookies: {},
  serverCookies: {},
  localStorage: {},
  sessionStorage: {},
  databases: [],
  idbRecord: null,
  caches: [],
  cacheEntry: null,
  registrations: [],
  controller: null,
};

/** Waits until the `/sentinel` page on `page` finished every write, failing on the page's error. */
export async function sentinelsWritten(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const state = window as FixtureWindow;
    return state.__sentinelDone === true || state.__sentinelError !== undefined;
  });
  expect(await page.evaluate(() => (window as FixtureWindow).__sentinelError)).toBeUndefined();
}

/** Opens `/sentinel` at `origin` and waits until every write finished. */
export async function writeSentinels(page: Page, origin: string, query: string): Promise<void> {
  await page.goto(`${origin}/sentinel?${query}`);
  await sentinelsWritten(page);
}

/** What the `/inspect` page already open on `page` read. */
export async function inspected(page: Page): Promise<Inspected> {
  const handle = await page.waitForFunction(() => (window as FixtureWindow).__inspected);
  return (await handle.jsonValue()) as Inspected;
}

/** Opens `/inspect` at `origin` and returns what the page read. */
export async function inspect(page: Page, origin: string, run: string): Promise<Inspected> {
  await page.goto(`${origin}/inspect?run=${run}`);
  return inspected(page);
}

/** What `/inspect` reads on `origin` after `/sentinel?tag=<tag>` ran in the same tab. */
export const holding = (tag: string, origin: string): Partial<Inspected> => ({
  cookies: { sentinel_js: tag },
  serverCookies: { sentinel_js: tag, sentinel_http: tag },
  localStorage: { sentinel: tag },
  sessionStorage: { sentinel: tag },
  databases: ["sentinel"],
  idbRecord: tag,
  caches: ["sentinel"],
  cacheEntry: tag,
  registrations: [`${origin}/`],
});
