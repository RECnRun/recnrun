import type { WorkspaceOperation } from "@recnrun/domain";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { barrierOf, installAnonymousBarrier, installBarrier } from "@/background/workspace/barrier";
import { recoverInterrupted } from "@/background/workspace/recovery";
import { exposeResponseUrls } from "@/background/workspace/response-urls";
import { closeManagedWindow, createNeutralWindow } from "@/background/workspace/windows";
import type { ResponseUrls } from "@/ports/response-urls";
import { managedWindowRepository } from "@/storage/managed-window-repository";
import { fakeBarrierApi } from "./fake-barrier";
import type { FakeBarrierApi } from "./fake-barrier";
import { memoryResponseUrls } from "./fake-helper";
import { memoryOperationJournal } from "./fake-journal";
import { openIncognitoWindow, openWindowsWithTabs } from "./fake-windows";

const ORIGIN = "http://app.localhost:5192";
const TARGET = ORIGIN;
const INTERRUPTED = "Interrupted: RECnRun restarted before the start finished.";

let barrier: FakeBarrierApi;

/** A start that got as far as `step`, with its window open and both its barriers installed. */
async function interruptedAt(step: string) {
  const window = await createNeutralWindow();
  const { generation, windowId, tabId } = window;
  await installBarrier(tabId, TARGET, { id: "op-1", generation }, barrier);
  // A reopened tab's barrier, which stands beside the primary tab's.
  await installAnonymousBarrier(tabId + 1, TARGET, { id: "op-1", generation, lane: 1 }, barrier);
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

test("an interrupted start is recorded failed at its step, then its barrier, window, and scripts go", async () => {
  const { operation, windowId, generation } = await interruptedAt("reload");
  const urls = { [ORIGIN]: [[`${ORIGIN}/a`, `${ORIGIN}/a`]] } satisfies ResponseUrls;
  await exposeResponseUrls(generation, urls, { barrier, responseUrls: memoryResponseUrls() });
  const journal = memoryOperationJournal(operation);
  const failed = { ...operation, status: "failed", error: INTERRUPTED };
  await expect(recover(journal)).resolves.toEqual(failed);
  expect(await journal.read()).toEqual(failed);
  const other = barrierOf({ id: "op-other", generation: 9 });
  expect([...barrier.rules.keys()]).toEqual(other.ruleIds.slice(0, 5));
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
  expect(barrier.rules.size).toBe(5);
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
  // The other generation's 5 rules, and the primary's 5 and the reopened tab's 6 of this one.
  expect(barrier.rules.size).toBe(16);
  expect(await isOpen(windowId)).toBe(true);
});

test("an interrupted start closes every window of its session, the journaled one or not", async () => {
  const { operation, windowId } = await interruptedAt("restore");
  const beside = await openIncognitoWindow();
  await recover(memoryOperationJournal(operation));
  expect(await isOpen(windowId)).toBe(false);
  expect(await isOpen(beside)).toBe(false);
});

test("windows stay open once the operation's session is no longer the open one", async () => {
  const { operation, windowId, generation } = await interruptedAt("restore");
  const other = await openIncognitoWindow();
  await recover(memoryOperationJournal({ ...operation, generation: generation + 1 }));
  await managedWindowRepository.update(
    async (current) => current && { ...current, status: "closed" },
  );
  await recover(memoryOperationJournal(operation));
  expect(await isOpen(other)).toBe(true);
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
