import type { Page } from "@playwright/test";
import { BLANK } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { newIdentity, opened, switchTo } from "./fixtures/panel.ts";
import { openSite } from "./fixtures/session.ts";
import { APP, pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

/** Caches two fetched responses, one of them redirected, as an app caches its pages. */
const fillFetched = (page: Page) =>
  page.evaluate(async () => {
    const cache = await caches.open("pages-v1");
    await cache.put("/cache/basic", await fetch("/cache/basic"));
    await cache.put("/cache/redirect", await fetch("/cache/redirect"));
  });

/** The URL of each response the page reads back, through every lookup an app uses. */
const responseUrls = (page: Page) =>
  page.evaluate(async () => {
    const cache = await caches.open("pages-v1");
    const basic = await cache.match("/cache/basic");
    return {
      match: basic?.url,
      redirected: (await cache.match("/cache/redirect"))?.url,
      matchAll: (await cache.matchAll()).map(({ url }) => url),
      storageMatch: (await caches.match("/cache/redirect"))?.url,
      clone: basic?.clone().url,
    };
  });

/** A response the app builds itself after the start keeps the empty URL a built one has. */
const builtUrls = (page: Page) =>
  page.evaluate(async () => {
    const cache = await caches.open("pages-v1");
    await cache.put("/cache/built", new Response("built"));
    const built = await cache.match("/cache/built");
    return {
      match: built?.url,
      matchAll: (await cache.matchAll("/cache/built")).map((r) => r.url),
    };
  });

const FETCHED = {
  match: `${APP}/cache/basic`,
  redirected: `${APP}/cache/basic?via=redirect`,
  matchAll: [`${APP}/cache/basic`, `${APP}/cache/basic?via=redirect`],
  storageMatch: `${APP}/cache/basic?via=redirect`,
  clone: `${APP}/cache/basic`,
};

test("a restored cache entry has the URL it was fetched from, across two Switches", async ({
  context,
}) => {
  const site = await openSite(context, "/");
  await newIdentity(site, BLANK);
  await opened(site, "A");
  const source = await pageAt(context, BLANK);
  await fillFetched(source);
  expect(await responseUrls(source)).toEqual(FETCHED);
  await newIdentity(site, BLANK);
  await opened(site, "B");

  for (const round of [1, 2]) {
    await switchTo(site, "A");
    await opened(site, "A");
    const back = await pageAt(context, BLANK);
    expect(await responseUrls(back), `round ${round}`).toEqual(FETCHED);
    await switchTo(site, "B");
    await opened(site, "B");
  }

  await switchTo(site, "A");
  await opened(site, "A");
  const last = await pageAt(context, BLANK);
  expect(await responseUrls(last)).toEqual(FETCHED);
  expect(await builtUrls(last)).toEqual({ match: "", matchAll: [""] });
});
