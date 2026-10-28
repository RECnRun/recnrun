import type { BrowserContext, Page, Worker } from "@playwright/test";
import { dumpDatabases, nextOrderKey, writeSchemaA, writeSchemaB } from "./fixtures/databases.ts";
import { expect, test } from "./fixtures/extension.ts";
import {
  barrierLeft,
  captureIdentity,
  incognitoWindows,
  startFromCapture,
  startWithIdentity,
} from "./fixtures/identity.ts";
import { keep } from "./fixtures/keep.ts";
import { APP, pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

const BLANK = `${APP}/blank`;
const EMPTY = { cookies: [], site: { localStorage: {}, sessionStorage: {}, indexedDB: [] } };

/** Opens the managed window at the blank page with nothing restored, as a first session would. */
async function openBlank(context: BrowserContext, serviceWorker: Worker): Promise<Page> {
  await startWithIdentity(serviceWorker, BLANK, EMPTY);
  return pageAt(context, BLANK);
}

/** Closes the managed tab and waits until Chrome lists no Incognito window. */
async function closeWorkspace(serviceWorker: Worker, page: Page): Promise<void> {
  await page.close();
  await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
}

test("each identity's IndexedDB comes back with its own schema, keys, and records", async ({
  context,
  serviceWorker,
}) => {
  const pageA = await openBlank(context, serviceWorker);
  await writeSchemaA(pageA);
  const sourceA = await dumpDatabases(pageA);
  const sourceNextKey = await nextOrderKey(pageA);
  const summaryA = await captureIdentity(serviceWorker, "identity-a");
  expect(summaryA).toMatchObject({ databases: 2, records: 10 });
  // The capture injected its agent once and left nothing registered.
  await expect(barrierLeft(serviceWorker)).resolves.toEqual({ rules: 0, scripts: 0 });
  await closeWorkspace(serviceWorker, pageA);

  const pageB = await openBlank(context, serviceWorker);
  await expect(dumpDatabases(pageB)).resolves.toEqual([]);
  await writeSchemaB(pageB);
  const sourceB = await dumpDatabases(pageB);
  const summaryB = await captureIdentity(serviceWorker, "identity-b");
  expect(summaryB).toMatchObject({ databases: 1, records: 2 });
  await closeWorkspace(serviceWorker, pageB);

  await startFromCapture(serviceWorker, "identity-a");
  const restoredA = await pageAt(context, BLANK);
  await expect(dumpDatabases(restoredA)).resolves.toEqual(sourceA);
  const restoredNextKey = await nextOrderKey(restoredA);
  await closeWorkspace(serviceWorker, restoredA);

  await startFromCapture(serviceWorker, "identity-b");
  const restoredB = await pageAt(context, BLANK);
  await expect(dumpDatabases(restoredB)).resolves.toEqual(sourceB);
  await closeWorkspace(serviceWorker, restoredB);

  // Restoring writes keys 1 and 2 only; the source's generator also remembers the deleted 3.
  expect({ sourceNextKey, restoredNextKey }).toEqual({ sourceNextKey: 4, restoredNextKey: 3 });
  await keep("capture-indexeddb", {
    identities: { a: summaryA, b: summaryB },
    autoIncrement: { sourceNextKey, restoredNextKey },
    schemas: [sourceA, sourceB].map((databases) =>
      databases.map(({ name, version, stores }) => ({
        name,
        version,
        stores: stores.map((store) => `${store.name}: ${store.records.length}`),
      })),
    ),
  });
});

test("an identity without a capture does not start, and leaves no window", async ({
  serviceWorker,
}) => {
  await expect(startFromCapture(serviceWorker, "identity-none")).rejects.toThrow(
    /no saved data for this identity/,
  );
  await expect(incognitoWindows(serviceWorker)).resolves.toBe(0);
});
