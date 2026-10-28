import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { managedWindowRepository } from "@/storage/managed-window-repository";
import { fakeCookieApi, memoryStoreMemory } from "./fake-cookies";
import { memoryRecordingStore } from "./fake-extension";
import { openIncognitoWindow, openWindowsWithTabs } from "./fake-windows";
import {
  allowIncognito,
  busyReply,
  contentScript,
  fakeWorkspacePorts,
  holdNextNavigation,
  RECORDING_FIRST,
  readStatus,
  TARGET,
  workspaceBackground,
} from "./workspace-harness";
import type { Send } from "./workspace-harness";

const NEXT = "https://app.example/next";
const restart = { type: "workspace-restart", url: NEXT };
const noWorkspace = { ok: false, error: "No Incognito workspace is open; start one first." };

let send: Send;

/** Starts the managed window and clears the spies, so a test sees only the restart's calls. */
async function startManaged() {
  expect(await send({ type: "workspace-start", url: TARGET })).toEqual({ ok: true });
  vi.mocked(fakeBrowser.windows.create).mockClear();
  const managed = await managedWindowRepository.read();
  if (managed === null) throw new Error("No managed window");
  return managed;
}

beforeEach(() => {
  fakeBrowser.reset();
  openWindowsWithTabs();
  allowIncognito(true);
  send = workspaceBackground();
});

// The Node projects share a worker, so a spy left on the fake browser would reach other files.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("workspace-restart", () => {
  test("closes the managed window, then opens a fresh one, then navigates its tab", async () => {
    const previous = await startManaged();
    const remove = vi.spyOn(fakeBrowser.windows, "remove");
    const create = vi.mocked(fakeBrowser.windows.create);
    const update = vi.spyOn(fakeBrowser.tabs, "update");
    expect(await send(restart)).toEqual({ ok: true });
    expect(remove.mock.calls.map(([id]) => id)).toEqual([previous.windowId]);
    expect(create).toHaveBeenCalledWith({ incognito: true, url: "about:blank" });
    const managed = await managedWindowRepository.read();
    expect(update).toHaveBeenCalledWith(managed?.tabId, { url: NEXT });
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0] ?? 0,
    );
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0] ?? 0,
    );
    expect(managed).toMatchObject({ status: "active", generation: previous.generation + 1 });
    expect(managed?.windowId).not.toBe(previous.windowId);
  });

  test("remembers the managed window's store before closing it, and waits for Chrome to forget it", async () => {
    // A tab id fakeBrowser never hands out, so the normal store cannot share the managed tab's id.
    const normal = { id: "0", tabIds: [1000] };
    const cookies = fakeCookieApi([[normal]], [1000]);
    const memory = memoryStoreMemory();
    send = workspaceBackground(memoryRecordingStore(), fakeWorkspacePorts(cookies, memory));
    const previous = await startManaged();
    // Chrome lists the managed tab's store only while its window is open, and forgets it a probe later.
    const listed = async () =>
      (await fakeBrowser.windows.getAll()).some(({ id }) => id === previous.windowId);
    cookies.stores = async () =>
      (await listed()) ? [normal, { id: "1", tabIds: [previous.tabId] }] : [normal];
    cookies.incognitoTabIds = async () => ((await listed()) ? [previous.tabId] : []);
    cookies.alive.set("1", [true, false]);
    expect(await send(restart)).toEqual({ ok: true });
    expect(memory.ids).toEqual(["1"]);
    expect(cookies.probes).toEqual(["1", "1"]);
  });

  test("refuses without an active managed window, and opens nothing", async () => {
    expect(await send(restart)).toEqual(noWorkspace);
    const previous = await startManaged();
    await fakeBrowser.windows.remove(previous.windowId);
    await managedWindowRepository.update((current) => current && { ...current, status: "closed" });
    expect(await send(restart)).toEqual(noWorkspace);
    expect(fakeBrowser.windows.create).not.toHaveBeenCalled();
  });

  test("refuses while another Incognito window is open, and closes nothing", async () => {
    await startManaged();
    await openIncognitoWindow();
    const remove = vi.spyOn(fakeBrowser.windows, "remove");
    expect(await send(restart)).toEqual({
      ok: false,
      error: "Close the other Incognito windows first.",
    });
    expect(remove).not.toHaveBeenCalled();
  });

  test("refuses while a recording session exists, and closes nothing", async () => {
    const session = { tabId: 1, status: "paused" as const, banked: 0, since: 0 };
    send = workspaceBackground(memoryRecordingStore(session));
    await startManaged();
    const remove = vi.spyOn(fakeBrowser.windows, "remove");
    expect(await send(restart)).toEqual(RECORDING_FIRST);
    expect(remove).not.toHaveBeenCalled();
    expect(fakeBrowser.windows.create).not.toHaveBeenCalled();
  });

  test("refuses without access to Incognito, and closes nothing", async () => {
    await startManaged();
    allowIncognito(false);
    const remove = vi.spyOn(fakeBrowser.windows, "remove");
    expect(await send(restart)).toEqual({ ok: false, error: "Allow RECnRun in Incognito first." });
    expect(remove).not.toHaveBeenCalled();
  });

  test("refuses an internal target before closing anything", async () => {
    await startManaged();
    const remove = vi.spyOn(fakeBrowser.windows, "remove");
    expect(await send({ type: "workspace-restart", url: "about:blank" })).toEqual({
      ok: false,
      error: "Only http and https pages can open in the Incognito workspace.",
    });
    expect(remove).not.toHaveBeenCalled();
  });

  test("refuses while another operation runs, and the other way round", async () => {
    await startManaged();
    const finish = holdNextNavigation();
    const first = send(restart);
    await vi.waitFor(() => expect(fakeBrowser.tabs.update).toHaveBeenCalled());
    expect(await readStatus(send)).toMatchObject({ busy: true });
    expect(await send(restart)).toEqual(busyReply);
    expect(await send({ type: "workspace-start", url: TARGET })).toEqual(busyReply);
    finish();
    expect(await first).toEqual({ ok: true });
  });

  test("answers only the extension's own pages", async () => {
    await expect(send(restart, contentScript)).rejects.toThrow("No answer");
  });
});
