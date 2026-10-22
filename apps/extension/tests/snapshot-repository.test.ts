import { emptySnapshot } from "@recnrun/domain";
import { sampleSnapshot } from "@recnrun/domain/testing";
import { beforeEach, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { readSnapshot } from "@/storage/snapshot-repository";

beforeEach(() => {
  fakeBrowser.reset();
});

test("returns an empty snapshot before anything is stored", async () => {
  await expect(readSnapshot()).resolves.toEqual(emptySnapshot());
});

test("returns the stored snapshot", async () => {
  await fakeBrowser.storage.local.set({ snapshot: sampleSnapshot() });
  await expect(readSnapshot()).resolves.toEqual(sampleSnapshot());
});

test("rejects stored data from an incompatible schema", async () => {
  await fakeBrowser.storage.local.set({ snapshot: { schemaVersion: 99 } });
  await expect(readSnapshot()).rejects.toThrow(/current schema/);
});
