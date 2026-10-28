import type { Page } from "@playwright/test";
import { expect } from "./fixtures/extension.ts";
import { framesOf, pair, test } from "./fixtures/profiles.ts";
import type { Profile } from "./fixtures/profiles.ts";
import { storedText } from "./fixtures/tabs.ts";

/** Signs a user in to the same web application, as far as the browser's storage goes. */
async function signIn(profile: Profile, user: string, path: string): Promise<Page> {
  const app = await profile.context.newPage();
  await app.goto(path);
  await app.evaluate(async (token) => {
    document.cookie = `session=${token}; path=/`;
    localStorage.setItem("token", token);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("app", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("auth");
      open.onsuccess = () => {
        const write = open.result.transaction("auth", "readwrite");
        write.objectStore("auth").put(token, "token");
        write.oncomplete = () => resolve();
      };
      open.onerror = () => reject(open.error ?? new Error("IndexedDB failed"));
    });
    const cache = await caches.open("app");
    await cache.put("/me", new Response(token));
  }, user);
  return app;
}

/** What the application finds in the browser's storage for its own origin. */
const seen = (app: Page) =>
  app.evaluate(async () => {
    const idb = await new Promise<unknown>((resolve) => {
      const open = indexedDB.open("app", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("auth");
      open.onsuccess = () => {
        const read = open.result.transaction("auth").objectStore("auth").get("token");
        read.onsuccess = () => resolve(read.result);
      };
    });
    const cached = await (await caches.open("app")).match("/me");
    return {
      cookie: document.cookie,
      local: localStorage.getItem("token"),
      idb,
      cache: cached ? await cached.text() : null,
    };
  });

test("each profile keeps its own cookies, storage, and cache; none of it crosses the link", async ({
  profileA,
  profileB,
}) => {
  const tokenA = `user-a-${crypto.randomUUID()}`;
  const tokenB = `user-b-${crypto.randomUUID()}`;
  const appA = await signIn(profileA, tokenA, "/privacy/?app-a");
  const appB = await signIn(profileB, tokenB, "/privacy/?app-b");
  await pair(profileA, profileB);
  // The tabs of each profile cross the link, as reports from both sides.
  await appB.reload();
  await appA.reload();
  await expect.poll(async () => (await framesOf(profileA)).join()).toContain(appB.url());

  expect(await seen(appA)).toEqual({
    cookie: `session=${tokenA}`,
    local: tokenA,
    idb: tokenA,
    cache: tokenA,
  });
  expect(await seen(appB)).toEqual({
    cookie: `session=${tokenB}`,
    local: tokenB,
    idb: tokenB,
    cache: tokenB,
  });
  for (const profile of [profileA, profileB]) {
    const crossed = (await framesOf(profile)).join("\n");
    const stored = await storedText(profile.serviceWorker);
    for (const token of [tokenA, tokenB]) {
      expect(crossed).not.toContain(token);
      expect(stored).not.toContain(token);
    }
  }
});
