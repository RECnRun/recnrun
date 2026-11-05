import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, expect, test } from "vite-plus/test";
import { pocTransportStore } from "@/storage/poc-transport-repository";

beforeEach(() => fakeBrowser.reset());

test("reads no error and no pause from an empty store", async () => {
  expect(await pocTransportStore().lastError()).toBeNull();
  expect(await pocTransportStore().paused()).toBeNull();
});

test("reads a stored error and ignores a value that fits no schema", async () => {
  await fakeBrowser.storage.local.set({ pocTransportError: { at: 3, message: "x" } });
  expect(await pocTransportStore().lastError()).toEqual({ at: 3, message: "x" });
  await fakeBrowser.storage.local.set({ pocTransportError: "x", pocPaused: "other" });
  expect(await pocTransportStore().lastError()).toBeNull();
  expect(await pocTransportStore().paused()).toBeNull();
});

test("records the last error with the time it happened", async () => {
  await pocTransportStore().recordError("write failed");
  const error = await pocTransportStore().lastError();
  expect(error?.message).toBe("write failed");
  expect(error?.at).toBeGreaterThan(0);
  await pocTransportStore().recordError("again");
  expect((await pocTransportStore().lastError())?.message).toBe("again");
});
