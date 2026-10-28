import type { Page } from "@playwright/test";
import type { Inspected } from "./apps/pages.ts";
import { expect, test } from "./fixtures/extension.ts";

const APP = "http://app.localhost:5192";
const OTHER = "http://other.localhost:5192";
// Node may not resolve *.localhost, so the spec reaches the server log through plain localhost.
const LOG = "http://localhost:5192/__log";
const TAG = "normal-1";

interface FixtureWindow {
  __sentinelDone?: boolean;
  __sentinelError?: string;
  __inspected?: Inspected;
}

/** Opens `/sentinel` and waits until every write finished, failing on the page's error. */
async function writeSentinels(page: Page, query: string): Promise<void> {
  await page.goto(`${APP}/sentinel?${query}`);
  await page.waitForFunction(() => {
    const state = window as FixtureWindow;
    return state.__sentinelDone === true || state.__sentinelError !== undefined;
  });
  expect(await page.evaluate(() => (window as FixtureWindow).__sentinelError)).toBeUndefined();
}

/** Opens `/inspect` at `origin` and returns what the page read. */
async function inspect(page: Page, origin: string, run: string): Promise<Inspected> {
  await page.goto(`${origin}/inspect?run=${run}`);
  const handle = await page.waitForFunction(() => (window as FixtureWindow).__inspected);
  return (await handle.jsonValue()) as Inspected;
}

interface LogEntry {
  kind: string;
  method?: string;
  path?: string;
  host?: string;
}

test("the fixture server keeps every sentinel kind on its own origin", async ({
  context,
  page,
}) => {
  const run = `fixture-${Date.now()}`;
  await writeSentinels(page, `tag=${TAG}&run=${run}`);

  const seen = await inspect(page, APP, run);
  expect(seen).toMatchObject({
    cookies: { sentinel_js: TAG },
    serverCookies: { sentinel_js: TAG, sentinel_http: TAG },
    localStorage: { sentinel: TAG },
    sessionStorage: { sentinel: TAG },
    databases: ["sentinel"],
    idbRecord: TAG,
    caches: ["sentinel"],
    cacheEntry: TAG,
    registrations: [`${APP}/`],
  });
  // HttpOnly keeps the server's cookie out of the page's reach.
  expect(seen.cookies).not.toHaveProperty("sentinel_http");

  const other = await context.newPage();
  expect(await inspect(other, OTHER, run)).toEqual({
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
  });

  const { entries } = (await (await fetch(`${LOG}?run=${run}`)).json()) as {
    entries: LogEntry[];
  };
  expect(entries).toContainEqual(
    expect.objectContaining({ kind: "request", path: "/sentinel", host: "app.localhost:5192" }),
  );
  expect(entries.filter(({ kind }) => kind === "report")).toHaveLength(2);
});
