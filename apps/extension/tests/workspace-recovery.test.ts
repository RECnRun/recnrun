import type { WorkspaceOperation } from "@recnrun/domain";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { installBarrier } from "@/background/workspace/barrier";
import { recoverInterrupted } from "@/background/workspace/recovery";
import { closeManagedWindow, createNeutralWindow } from "@/background/workspace/windows";
import { fakeBarrierApi } from "./fake-barrier";
import type { FakeBarrierApi } from "./fake-barrier";
import { memoryOperationJournal } from "./fake-journal";
import { openIncognitoWindow, openWindowsWithTabs } from "./fake-windows";

const ORIGIN = "http://app.localhost:5192";
const TARGET = { origin: ORIGIN, declaredHosts: [] };
const INTERRUPTED = "Interrupted: RECnRun restarted before the start finished.";

let barrier: FakeBarrierApi;

/** A start that got as far as `step`, with its window open and its barrier installed. */
async function interruptedAt(step: string) {
  const window = await createNeutralWindow();
  const { generation, windowId, tabId } = window;
  await installBarrier(tabId, TARGET, { id: "op-1", generation }, barrier);
  const operation: WorkspaceOperation = {
    id: "op-1",
    kind: "start-with-identity",
    step,
    status: "running",
    started: 1,
    generation,
    windowId,
  };
  return { operation, windowId, generation };
}

const isOpen = async (windowId: number) =>
  (await fakeBrowser.windows.getAll()).some(({ id }) => id === windowId);

const recover = (journal: ReturnType<typeof memoryOperationJournal>) =>
  recoverInterrupted({ journal, barrier, closeWindow: closeManagedWindow });

beforeEach(async () => {
  fakeBrowser.reset();
  openWindowsWithTabs();
  barrier = fakeBarrierApi();
  // Another generation's barrier, which recovery must leave alone.
  await installBarrier(77, TARGET, { id: "op-other", generation: 9 }, barrier);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("an interrupted start is recorded failed at its step, then its barrier and window go", async () => {
  const { operation, windowId } = await interruptedAt("restore");
  const journal = memoryOperationJournal(operation);
  const failed = { ...operation, status: "failed", error: INTERRUPTED };
  await expect(recover(journal)).resolves.toEqual(failed);
  expect(await journal.read()).toEqual(failed);
  expect([...barrier.rules.keys()]).toEqual([91, 92, 93, 94]);
  expect([...barrier.scripts.keys()]).toEqual(["recnrun-origin-agent-op-other"]);
  expect(await isOpen(windowId)).toBe(false);
});

test("the recorded error names the command the restart interrupted", async () => {
  const named = {
    "start-with-identity": "the start",
    switch: "the switch",
    suspend: "the suspension",
    resume: "the resumption",
    "new-identity": "the new identity's creation",
    "delete-identity": "the deletion",
  } as const;
  for (const [kind, noun] of Object.entries(named)) {
    const operation: WorkspaceOperation = {
      id: "op-1",
      kind: kind as WorkspaceOperation["kind"],
      step: "capture",
      status: "running",
      started: 1,
    };
    const journal = memoryOperationJournal(operation);
    await recover(journal);
    expect((await journal.read())?.error, kind).toBe(
      `Interrupted: RECnRun restarted before ${noun} finished.`,
    );
  }
});

test("a start interrupted before its window existed is recorded failed and removes nothing", async () => {
  const operation: WorkspaceOperation = {
    id: "op-1",
    kind: "start-with-identity",
    step: "store-gone",
    status: "running",
    started: 1,
  };
  const journal = memoryOperationJournal(operation);
  await recover(journal);
  expect(await journal.read()).toMatchObject({ step: "store-gone", status: "failed" });
  expect(barrier.rules.size).toBe(4);
});

test("a finished, failed, or missing operation is left as it is", async () => {
  const { operation, windowId } = await interruptedAt("reload");
  for (const kept of [null, { ...operation, status: "done" as const }]) {
    const journal = memoryOperationJournal(kept);
    await expect(recover(journal)).resolves.toBeUndefined();
    expect(journal.written).toEqual([]);
  }
  const failed = { ...operation, status: "failed" as const, error: "Earlier." };
  await expect(recover(memoryOperationJournal(failed))).resolves.toBeUndefined();
  expect(barrier.rules.size).toBe(8);
  expect(await isOpen(windowId)).toBe(true);
});

test("a window that is no longer the operation's managed window stays open", async () => {
  const { operation, windowId, generation } = await interruptedAt("restore");
  const foreign = await openIncognitoWindow();
  await recover(memoryOperationJournal({ ...operation, windowId: foreign }));
  await recover(memoryOperationJournal({ ...operation, generation: generation + 1 }));
  expect(await isOpen(foreign)).toBe(true);
  expect(await isOpen(windowId)).toBe(true);
});

test("a cleanup that fails is added to the recorded error", async () => {
  const { operation } = await interruptedAt("navigate");
  barrier.ignoreRemovals = true;
  const journal = memoryOperationJournal(operation);
  await recover(journal);
  expect((await journal.read())?.error).toBe(
    `${INTERRUPTED} Cleanup also failed: Chrome still lists the barrier after removing it.`,
  );
});
