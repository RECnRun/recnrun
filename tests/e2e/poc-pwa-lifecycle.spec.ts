import type { BrowserContext, Page, Worker } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import { incognitoWindows, journalOf } from "./fixtures/identity.ts";
import { keep } from "./fixtures/keep.ts";
import {
  identitiesAt,
  lifecycleDriver,
  marksOf,
  nextPageAt,
  stepDurations,
  watchJournal,
} from "./fixtures/lifecycle.ts";
import { pwaApiCalls, pwaAsk, pwaLoaded, pwaServer, pwaSignIn, pwaUrl } from "./fixtures/pwa.ts";

test.use({ incognitoAccess: true });

/** What an origin shows when nothing was restored into it. */
const FRESH = { profile: null, idbUser: null, controlled: false, servedByWorker: false };

/** Identities by label at the PWA of `run`, and the managed tab as it changes. */
async function pwaSetUp(context: BrowserContext, serviceWorker: Worker, run: string) {
  await watchJournal(serviceWorker);
  const url = pwaUrl(run);
  const driver = await lifecycleDriver(context, serviceWorker);
  const identities = identitiesAt(driver.command, url);
  const tab: { page?: Page } = {};
  const samples: Record<string, unknown>[] = [];
  /** Runs a lifecycle command and waits for the app it opens to be controlled by its worker. */
  const opened = async (label: string, command: () => Promise<unknown>) => {
    const started = Date.now();
    const marks = await marksOf(serviceWorker, command);
    const ended = Date.now();
    tab.page = await nextPageAt(context, url, tab.page);
    const loaded = await pwaLoaded(tab.page);
    samples.push({
      label,
      commandMs: ended - started,
      steps: stepDurations(marks),
      firstAfterCommandMs: loaded.first.time - ended,
      readyAfterFirstMs: loaded.ready.time - loaded.first.time,
    });
    return { page: tab.page, ...loaded };
  };
  const open = (label: string) => opened(label, () => identities.open(label));
  return { identities, tab, samples, open, opened };
}

/** Signs a new identity in and checks that its own worker answers for it. */
async function signIn(page: Page, user: string) {
  await pwaSignIn(page, user);
  expect(await pwaAsk(page)).toMatchObject({
    me: { user, from: "worker" },
    idbUser: user,
    lastSeen: null,
    cachedBefore: null,
  });
}

test("the PWA keeps each identity's sign-in, worker data, and caches through A → B → A → C → A", async ({
  context,
  serviceWorker,
}) => {
  test.setTimeout(120_000);
  const run = `pwa-rounds-${Date.now()}`;
  const { open, samples } = await pwaSetUp(context, serviceWorker, run);
  const first = await open("A");
  expect(first.first).toMatchObject({ ...FRESH, version: 1 });
  await signIn(first.page, "A");
  for (const label of ["B", "A", "C", "A"]) {
    const { page, first: reads, ready } = await open(label);
    if (label !== "A") {
      expect(reads, label).toMatchObject(FRESH);
      await signIn(page, label);
      continue;
    }
    // Restored data, but no registration: the worker installs again and claims the page.
    expect(reads).toMatchObject({ ...FRESH, profile: "A", idbUser: "A" });
    expect(ready.registerError).toBeNull();
    expect(await pwaAsk(page)).toMatchObject({
      me: { user: "A", version: 1, from: "worker" },
      idbUser: "A",
      lastSeen: "A",
      cachedBefore: { user: "A" },
      caches: ["pwa-api", "pwa-v1"],
    });
    await page.reload();
    const reloaded = await pwaLoaded(page);
    expect(reloaded.first).toMatchObject({ profile: "A", controlled: true, servedByWorker: true });
    expect(await pwaAsk(page)).toMatchObject({ me: { user: "A" }, lastSeen: "A" });
  }
  expect(await incognitoWindows(serviceWorker)).toBe(1);
  const api = await pwaApiCalls(run);
  expect(api.filter(({ cookies }) => cookies?.includes("pwa_user"))).toEqual(api);
  await keep("pwa-rounds", samples);
});

test("a PWA identity resumed after an app update installs the new version over its restored data", async ({
  context,
  serviceWorker,
}) => {
  const run = `pwa-update-${Date.now()}`;
  const { open, samples } = await pwaSetUp(context, serviceWorker, run);
  await signIn((await open("A")).page, "A");
  await signIn((await open("B")).page, "B");
  await pwaServer(run, { version: 2 });
  const { page, first } = await open("A");
  expect(first).toMatchObject({ profile: "A", idbUser: "A", controlled: false, version: 2 });
  // The new worker's activate deleted the restored `pwa-v1` shell.
  expect(await pwaAsk(page)).toMatchObject({
    version: 2,
    me: { user: "A", version: 2 },
    cachedBefore: { user: "A", version: 1 },
    caches: ["pwa-api", "pwa-v2"],
  });
  await keep("pwa-update", samples);
});

test("a resumed PWA works offline once its worker is back, and a resume while offline fails", async ({
  context,
  serviceWorker,
}) => {
  const run = `pwa-offline-${Date.now()}`;
  const { identities, open, opened, samples } = await pwaSetUp(context, serviceWorker, run);
  await signIn((await open("A")).page, "A");
  await signIn((await open("B")).page, "B");
  const { page } = await open("A");
  expect(await pwaAsk(page)).toMatchObject({ me: { user: "A" } });

  await pwaServer(run, { offline: true });
  await page.reload();
  expect((await pwaLoaded(page)).first).toMatchObject({ profile: "A", controlled: true });
  expect(await pwaAsk(page)).toMatchObject({ me: { offline: true, cached: { user: "A" } } });
  await pwaServer(run, { offline: false });

  await identities.suspend();
  await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
  await pwaServer(run, { offline: true });
  // No registration survives the window, so the first navigation needs the network.
  await expect(identities.resume("A")).rejects.toThrow(
    "The page did not load (net::ERR_EMPTY_RESPONSE).",
  );
  expect(await journalOf(serviceWorker)).toMatchObject({ step: "navigate", status: "failed" });
  expect(await incognitoWindows(serviceWorker)).toBe(0);

  await pwaServer(run, { offline: false });
  const back = await opened("A", () => identities.resume("A"));
  expect(back.first).toMatchObject({ profile: "A", idbUser: "A" });
  expect(await pwaAsk(back.page)).toMatchObject({ me: { user: "A" }, lastSeen: "A" });
  await keep("pwa-offline", samples);
});
