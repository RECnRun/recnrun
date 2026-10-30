import type { ManagedWindowState } from "@recnrun/domain";
import { beforeEach, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { managedWindowRepository } from "@/storage/managed-window-repository";

const active: ManagedWindowState = { generation: 1, windowId: 5, tabId: 50, status: "active" };

beforeEach(() => {
  fakeBrowser.reset();
});

test("stores the managed window under its own local key", async () => {
  expect(await managedWindowRepository.read()).toBeNull();
  expect(await managedWindowRepository.update(() => active)).toEqual(active);
  expect(await managedWindowRepository.read()).toEqual(active);
  expect(await fakeBrowser.storage.local.get("managed-window")).toEqual({
    "managed-window": active,
  });
});

test("applies changes one at a time, each on the state the previous one left", async () => {
  const seen: (ManagedWindowState | null)[] = [];
  const first = managedWindowRepository.update(async (current) => {
    seen.push(current);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return active;
  });
  const second = managedWindowRepository.update((current) => {
    seen.push(current);
    return current && { ...current, status: "closed" };
  });
  await Promise.all([first, second]);
  expect(seen).toEqual([null, active]);
  expect(await managedWindowRepository.read()).toEqual({ ...active, status: "closed" });
});

test("a failed change writes nothing and does not stop the next one", async () => {
  await expect(
    managedWindowRepository.update(() => {
      throw new Error("No window");
    }),
  ).rejects.toThrow("No window");
  expect(await managedWindowRepository.read()).toBeNull();
  expect(await managedWindowRepository.update(() => active)).toEqual(active);
});

test("rejects a stored state that does not match the schema, and never overwrites it", async () => {
  await fakeBrowser.storage.local.set({ "managed-window": { windowId: "five" } });
  await expect(managedWindowRepository.read()).rejects.toThrow(
    "The stored Incognito window does not match the current schema.",
  );
  await expect(managedWindowRepository.update(() => active)).rejects.toThrow(/current schema/);
  expect(await fakeBrowser.storage.local.get("managed-window")).toEqual({
    "managed-window": { windowId: "five" },
  });
});
