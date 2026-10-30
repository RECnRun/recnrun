import { beforeEach, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { incognitoStoreMemory } from "@/storage/incognito-stores";

const KEY = "incognito-store-ids";

beforeEach(() => {
  fakeBrowser.reset();
});

test("keeps each Incognito store id once, under its own local key", async () => {
  expect(await incognitoStoreMemory.read()).toEqual([]);
  await incognitoStoreMemory.remember(["1", "1"]);
  await incognitoStoreMemory.remember(["1", "2"]);
  expect(await incognitoStoreMemory.read()).toEqual(["1", "2"]);
  expect(await fakeBrowser.storage.local.get(KEY)).toEqual({ [KEY]: ["1", "2"] });
});

test("two changes at once keep both ids", async () => {
  await Promise.all([incognitoStoreMemory.remember(["1"]), incognitoStoreMemory.remember(["2"])]);
  expect(await incognitoStoreMemory.read()).toEqual(["1", "2"]);
});

test("refuses a stored value that does not match the schema, and recovers after a fix", async () => {
  await fakeBrowser.storage.local.set({ [KEY]: [""] });
  await expect(incognitoStoreMemory.read()).rejects.toThrow(
    "The stored Incognito cookie store ids do not match the current schema.",
  );
  await expect(incognitoStoreMemory.remember(["1"])).rejects.toThrow("current schema");
  await fakeBrowser.storage.local.set({ [KEY]: ["3"] });
  await incognitoStoreMemory.remember(["1"]);
  expect(await incognitoStoreMemory.read()).toEqual(["3", "1"]);
});
