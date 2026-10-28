import type { WorkspaceOperation } from "@recnrun/domain";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { operationJournal } from "@/storage/operation-journal";

const running: WorkspaceOperation = {
  id: "op-1",
  kind: "start-with-identity",
  step: "restore",
  status: "running",
  started: 1,
  generation: 2,
  windowId: 5,
};

beforeEach(() => {
  fakeBrowser.reset();
});

test("keeps the operation under its own local key until cleared", async () => {
  expect(await operationJournal.read()).toBeNull();
  await operationJournal.write(running);
  expect(await operationJournal.read()).toEqual(running);
  expect(await fakeBrowser.storage.local.get("workspace-operation")).toEqual({
    "workspace-operation": running,
  });
  await operationJournal.clear();
  expect(await operationJournal.read()).toBeNull();
});

test("refuses a stored operation that does not match the schema", async () => {
  await fakeBrowser.storage.local.set({ "workspace-operation": { ...running, id: "" } });
  await expect(operationJournal.read()).rejects.toThrow(
    "The stored workspace operation does not match the current schema.",
  );
});

test("tells watchers about each change until they unsubscribe", async () => {
  let changes = 0;
  const unwatch = operationJournal.watch(() => {
    changes += 1;
  });
  await operationJournal.write(running);
  await operationJournal.clear();
  await vi.waitFor(() => expect(changes).toBe(2));
  unwatch();
  await operationJournal.write(running);
  expect(changes).toBe(2);
});
