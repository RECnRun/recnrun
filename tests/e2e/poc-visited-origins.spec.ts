import type { Page } from "@playwright/test";
import { BLANK } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { incognitoWindows } from "./fixtures/identity.ts";
import { lifecycleSetUp, marksOf, stepDurations } from "./fixtures/lifecycle.ts";
import { APP } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

const extraOrigins = (count: number) =>
  Array.from({ length: count }, (_, index) => `http://extra${index + 1}.localhost:5192`);

interface Held {
  localStorage: string | null;
  indexedDB: unknown;
}

/** Writes `label` into the origin's localStorage and IndexedDB on its page in the managed tab. */
async function mark(page: Page, origin: string, label: string): Promise<void> {
  await page.goto(`${origin}/blank`);
  await page.evaluate(async (value) => {
    localStorage.setItem("who", value);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("visited", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const transaction = open.result.transaction("kv", "readwrite");
        transaction.objectStore("kv").put(value, "who");
        transaction.oncomplete = () => {
          open.result.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, label);
}

/** What the origin holds, read on its page in the managed tab without creating its database. */
async function held(page: Page, origin: string): Promise<Held> {
  await page.goto(`${origin}/blank`);
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).map(({ name }) => name);
    const stored = names.includes("visited")
      ? await new Promise<unknown>((resolve, reject) => {
          const open = indexedDB.open("visited");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const read = open.result.transaction("kv").objectStore("kv").get("who");
            read.onsuccess = () => {
              open.result.close();
              resolve(read.result);
            };
          };
        })
      : null;
    return { localStorage: localStorage.getItem("who"), indexedDB: stored };
  });
}

for (const count of [1, 3]) {
  test(`Switch to brings back the storage of ${count} other visited origin(s)`, async ({
    context,
    serviceWorker,
  }) => {
    const origins = extraOrigins(count);
    const { identities, next } = await lifecycleSetUp(context, serviceWorker);
    await identities.open("A");
    const a = await next();
    for (const origin of origins) await mark(a, origin, "A");
    await a.goto(BLANK);

    await identities.open("B");
    const b = await next();
    for (const origin of origins) {
      expect(await held(b, origin)).toEqual({ localStorage: null, indexedDB: null });
      await mark(b, origin, "B");
    }
    await b.goto(BLANK);

    const started = Date.now();
    const marks = await marksOf(serviceWorker, () => identities.open("A"));
    const switchMs = Date.now() - started;
    const back = await next();
    for (const origin of origins) {
      expect(await held(back, origin)).toEqual({ localStorage: "A", indexedDB: "A" });
    }
    expect(await held(back, APP)).toEqual({ localStorage: null, indexedDB: null });
    expect(await incognitoWindows(serviceWorker)).toBe(1);
    const steps = stepDurations(marks);
    test.info().annotations.push({
      type: "timing",
      description: JSON.stringify({ extraOrigins: count, switchMs, steps }),
    });
    console.log(
      `visited-origins timing ${JSON.stringify({ extraOrigins: count, switchMs, steps })}`,
    );
  });
}
