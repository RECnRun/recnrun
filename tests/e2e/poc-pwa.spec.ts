import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import { keep } from "./fixtures/keep.ts";
import {
  pwaApiCalls,
  pwaAsk,
  pwaLoaded,
  pwaServer,
  pwaSignIn,
  pwaUpdate,
  pwaUrl,
} from "./fixtures/pwa.ts";
import { openSite } from "./fixtures/session.ts";
import { APP, pageAt, startWorkspace } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

/** Reloads with the server offline: the worker serves its cached shell and the cached API answer. */
async function reloadOffline(page: Page, run: string) {
  await pwaServer(run, { offline: true });
  await page.reload();
  const offline = await pwaLoaded(page);
  expect(offline.first).toMatchObject({
    profile: "A",
    idbUser: "A",
    controlled: true,
    servedByWorker: true,
    version: 2,
  });
  expect(await pwaAsk(page)).toMatchObject({
    version: 2,
    me: { offline: true, cached: { user: "A", version: 2, from: "worker" } },
    idbUser: "A",
  });
  await pwaServer(run, { offline: false });
  return offline;
}

test("the PWA installs, signs in, updates, and works offline in a plain managed Incognito window", async ({
  context,
  serviceWorker,
}) => {
  const run = `pwa-native-${Date.now()}`;
  const url = pwaUrl(run);
  const site = await openSite(context, "/");
  await startWorkspace(site, serviceWorker, url);
  const page = await pageAt(context, url);

  const installed = await pwaLoaded(page);
  expect(installed.first).toMatchObject({
    profile: null,
    idbUser: null,
    controlled: false,
    servedByWorker: false,
    version: 1,
  });
  // clients.claim() hands the uncontrolled first page to the new worker.
  expect(installed.ready).toMatchObject({
    controller: `${APP}/pwa/sw.js?run=${run}`,
    scope: `${APP}/pwa/`,
    registerError: null,
  });
  const manifest = () => fetch("/pwa/manifest.json").then((response) => response.json());
  expect(await page.evaluate(manifest)).toMatchObject({ scope: "/pwa/", display: "standalone" });

  await pwaSignIn(page, "A");
  expect(await pwaAsk(page)).toEqual({
    version: 1,
    me: { user: "A", version: 1, from: "worker" },
    idbUser: "A",
    lastSeen: null,
    cachedBefore: null,
    caches: ["pwa-api", "pwa-v1"],
  });

  await page.reload();
  const controlled = await pwaLoaded(page);
  expect(controlled.first).toMatchObject({
    profile: "A",
    idbUser: "A",
    controlled: true,
    servedByWorker: true,
    version: 1,
  });
  expect(await pwaAsk(page)).toMatchObject({ lastSeen: "A", me: { user: "A" } });

  await pwaServer(run, { version: 2 });
  expect(await pwaUpdate(page)).toBe(`${APP}/pwa/sw.js?run=${run}`);
  expect(await pwaAsk(page)).toMatchObject({
    version: 2,
    me: { user: "A", version: 2, from: "worker" },
    caches: ["pwa-api", "pwa-v2"],
  });
  await page.reload();
  expect((await pwaLoaded(page)).first).toMatchObject({ version: 2, controlled: true });

  const offline = await reloadOffline(page, run);

  // Every worker-initiated API call carried the HttpOnly session cookie.
  const api = await pwaApiCalls(run);
  expect(api.length).toBeGreaterThanOrEqual(4);
  expect(
    api.filter(({ cookies, dest }) => dest === "empty" && cookies?.includes("pwa_user")),
  ).toEqual(api);
  await keep("pwa-native", {
    installMs: installed.ready.time - installed.first.time,
    controlledReloadMs: controlled.ready.time - controlled.first.time,
    offlineReloadMs: offline.ready.time - offline.first.time,
    offlineRegisterError: offline.ready.registerError,
  });
});
