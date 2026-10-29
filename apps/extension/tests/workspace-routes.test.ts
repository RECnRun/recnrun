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

let send: Send;
const status = () => readStatus(send);

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

describe("workspace-status", () => {
  test("reports access, the managed window, and foreign windows by id and tab count", async () => {
    const foreign = await openIncognitoWindow();
    expect(await status()).toEqual({
      siteAccess: true,
      access: true,
      foreign: [{ id: foreign, tabCount: 1 }],
      busy: false,
      identities: [],
    });
    await fakeBrowser.windows.remove(foreign);
    await send({ type: "workspace-start", url: TARGET });
    // A window opened while the session is open is the session's, never foreign.
    await openIncognitoWindow();
    const { managed, ...rest } = await status();
    expect(managed).toEqual(await managedWindowRepository.read());
    expect(rest).toEqual({
      siteAccess: true,
      access: true,
      foreign: [],
      busy: false,
      identities: [],
    });
  });

  test("reports no access when Chrome does not allow RECnRun in Incognito", async () => {
    allowIncognito(false);
    expect(await status()).toMatchObject({ access: false });
  });

  test("answers only the extension's own pages", async () => {
    for (const type of ["workspace-status", "workspace-start", "workspace-close-and-start"]) {
      const message = { type, url: TARGET, windowIds: [] };
      await expect(send(message, contentScript)).rejects.toThrow("No answer");
    }
  });
});

describe("workspace-start", () => {
  test("opens no window until Chrome forgot the previous Incognito profile", async () => {
    // Unlisted once its last tab closed (cookies_api.cc:895-904), the profile is destroyed later.
    const cookies = fakeCookieApi([[{ id: "0", tabIds: [1] }]], [1]);
    cookies.alive.set("1", [true, false]);
    const probe = vi.spyOn(cookies, "probe");
    send = workspaceBackground(
      memoryRecordingStore(),
      fakeWorkspacePorts(cookies, memoryStoreMemory(["1"])),
    );
    const create = vi.mocked(fakeBrowser.windows.create);
    expect(await send({ type: "workspace-start", url: TARGET })).toEqual({ ok: true });
    expect(cookies.probes).toEqual(["1", "1"]);
    expect(probe.mock.invocationCallOrder[1]).toBeLessThan(create.mock.invocationCallOrder[0] ?? 0);
  });

  test("opens the managed window on a blank page, then navigates its tab to the target", async () => {
    const update = vi.spyOn(fakeBrowser.tabs, "update");
    expect(await send({ type: "workspace-start", url: TARGET })).toEqual({ ok: true });
    const managed = await managedWindowRepository.read();
    expect(fakeBrowser.windows.create).toHaveBeenCalledWith({
      incognito: true,
      url: "about:blank",
    });
    expect(update).toHaveBeenCalledWith(managed?.tabId, { url: TARGET });
    expect((await fakeBrowser.tabs.get(managed?.tabId ?? -1)).url).toBe(TARGET);
  });

  test("refuses browser-internal and unparsable targets, and opens nothing", async () => {
    for (const url of ["chrome://settings/", "about:blank", "file:///etc/hosts", "not a url"]) {
      expect(await send({ type: "workspace-start", url })).toEqual({
        ok: false,
        error: "Only http and https pages can open in the Incognito workspace.",
      });
    }
    expect(fakeBrowser.windows.create).not.toHaveBeenCalled();
  });

  test("refuses while any Incognito window is open", async () => {
    await openIncognitoWindow();
    vi.mocked(fakeBrowser.windows.create).mockClear();
    expect(await send({ type: "workspace-start", url: TARGET })).toEqual({
      ok: false,
      error: "Close every Incognito window before RECnRun opens its own.",
    });
    expect(fakeBrowser.windows.create).not.toHaveBeenCalled();
  });

  test("refuses without access to Incognito, and opens nothing", async () => {
    allowIncognito(false);
    expect(await send({ type: "workspace-start", url: TARGET })).toEqual({
      ok: false,
      error: "Allow RECnRun in Incognito first.",
    });
    expect(fakeBrowser.windows.create).not.toHaveBeenCalled();
  });

  test("refuses a second operation while one runs, and reports itself busy", async () => {
    const finish = holdNextNavigation();
    const first = send({ type: "workspace-start", url: TARGET });
    await vi.waitFor(() => expect(fakeBrowser.tabs.update).toHaveBeenCalled());
    expect(await status()).toMatchObject({ busy: true });
    expect(await send({ type: "workspace-start", url: TARGET })).toEqual(busyReply);
    const closeAndStart = { type: "workspace-close-and-start", url: TARGET, windowIds: [] };
    expect(await send(closeAndStart)).toEqual(busyReply);
    finish();
    expect(await first).toEqual({ ok: true });
    expect(await status()).toMatchObject({ busy: false });
  });
});

describe("workspace-close-and-start", () => {
  test("closes the windows it was shown, then opens the managed window, then navigates", async () => {
    const shown = [await openIncognitoWindow(), await openIncognitoWindow()];
    const remove = vi.spyOn(fakeBrowser.windows, "remove");
    const create = vi.mocked(fakeBrowser.windows.create);
    create.mockClear();
    const update = vi.spyOn(fakeBrowser.tabs, "update");
    const message = { type: "workspace-close-and-start", url: TARGET, windowIds: shown };
    expect(await send(message)).toEqual({ ok: true });
    expect(remove.mock.calls.map(([id]) => id)).toEqual(shown);
    const lastRemove = Math.max(...remove.mock.invocationCallOrder);
    expect(lastRemove).toBeLessThan(create.mock.invocationCallOrder[0] ?? 0);
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0] ?? 0,
    );
    const { managed, foreign } = await status();
    expect(foreign).toEqual([]);
    expect(managed).toMatchObject({ status: "active", generation: 1 });
  });

  test("refuses when the windows changed since the user saw them, and closes none", async () => {
    const shown = await openIncognitoWindow();
    const appeared = await openIncognitoWindow();
    const remove = vi.spyOn(fakeBrowser.windows, "remove");
    const changed = {
      ok: false,
      error: "The Incognito windows changed; review them again before closing them.",
    };
    for (const windowIds of [[shown], [shown, appeared, 99], []]) {
      const message = { type: "workspace-close-and-start", url: TARGET, windowIds };
      expect(await send(message)).toEqual(changed);
    }
    expect(remove).not.toHaveBeenCalled();
    expect((await status()).foreign.map((each) => each.id)).toEqual([shown, appeared]);
  });

  test("refuses while a recording session exists, and closes none", async () => {
    send = workspaceBackground(
      memoryRecordingStore({ tabId: 1, status: "recording", banked: 0, since: 0 }),
    );
    const shown = await openIncognitoWindow();
    const remove = vi.spyOn(fakeBrowser.windows, "remove");
    const message = { type: "workspace-close-and-start", url: TARGET, windowIds: [shown] };
    expect(await send(message)).toEqual(RECORDING_FIRST);
    expect(remove).not.toHaveBeenCalled();
  });

  test("refuses while the managed window is open, and closes none", async () => {
    expect(await send({ type: "workspace-start", url: TARGET })).toEqual({ ok: true });
    const shown = await openIncognitoWindow();
    const remove = vi.spyOn(fakeBrowser.windows, "remove");
    const message = { type: "workspace-close-and-start", url: TARGET, windowIds: [shown] };
    const reply = await send(message);
    // One comparison, so a failure shows both the reply and any window closed before it.
    expect({ reply, removed: remove.mock.calls.map(([id]) => id) }).toEqual({
      reply: {
        ok: false,
        error:
          "Close and start empty replaces the open workspace; close the other Incognito windows first.",
      },
      removed: [],
    });
    expect((await status()).foreign).toEqual([]);
  });

  test("refuses an internal target before closing anything", async () => {
    const shown = await openIncognitoWindow();
    const remove = vi.spyOn(fakeBrowser.windows, "remove");
    const message = {
      type: "workspace-close-and-start",
      url: "chrome://newtab/",
      windowIds: [shown],
    };
    expect(await send(message)).toMatchObject({ ok: false });
    expect(remove).not.toHaveBeenCalled();
  });
});
