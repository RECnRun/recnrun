import { beforeEach, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { responseUrlStore } from "@/storage/response-urls";

const APP = "http://app.localhost:5192";
const URLS = { [APP]: [[`${APP}/a`, `${APP}/a?via=redirect`]] } satisfies Record<
  string,
  [string, string][]
>;

beforeEach(() => {
  fakeBrowser.reset();
});

test("keeps one generation's URLs in session storage, and none for another generation", async () => {
  expect(await responseUrlStore.read(1)).toEqual({});
  await responseUrlStore.write(1, URLS);
  expect(await responseUrlStore.read(1)).toEqual(URLS);
  expect(await responseUrlStore.read(2)).toEqual({});
  expect(await fakeBrowser.storage.session.get("response-urls")).toEqual({
    "response-urls": { generation: 1, origins: URLS },
  });
  await responseUrlStore.write(2, {});
  expect(await responseUrlStore.read(1)).toEqual({});
});

test("refuses a stored value that does not match its schema", async () => {
  await fakeBrowser.storage.session.set({ "response-urls": { generation: 1, origins: { x: 1 } } });
  await expect(responseUrlStore.read(1)).rejects.toThrow("do not match the current schema");
});
