import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createBackgroundListener } from "@/background/listener";
import { createRoutes } from "@/background/routes";
import { createWorkspaceCommands } from "@/background/workspace/commands";
import { BackgroundReplySchema } from "@/messaging/background-messages";
import { WorkspaceStatusSchema } from "@/messaging/workspace-protocol";
import { managedWindowRepository } from "@/storage/managed-window-repository";
import { openIncognitoWindow, openWindowsWithTabs } from "./fake-windows";
import { memoryRecordingStore } from "./fake-extension";

const EXTENSION_URL = "chrome-extension://own-id/";
const identity = { extensionId: "own-id", extensionUrl: EXTENSION_URL };
const ownPage = { id: "own-id", url: `${EXTENSION_URL}dashboard.html` };
const contentScript = { id: "own-id", url: "https://recnrun.com/" };
const TARGET = "https://app.example/";

let send: (message: unknown, sender?: object) => Promise<unknown>;

/** Delivers messages to one background, as Chrome would, and resolves with the validated reply. */
function background() {
  const routes = createRoutes({
    extensionVersion: "0.1.0",
    store: memoryRecordingStore(),
    workspace: createWorkspaceCommands(),
  });
  const listener = createBackgroundListener(routes, identity);
  return (message: unknown, sender: object = ownPage) =>
    new Promise<unknown>((resolve, reject) => {
      const answered = listener(message, sender as never, (reply) =>
        resolve(v.parse(BackgroundReplySchema, reply)),
      );
      if (!answered) reject(new Error("No answer"));
    });
}

/** Chrome's "Allow in Incognito" toggle; the spy takes the callback overload's type. */
function allowIncognito(allowed: boolean) {
  vi.spyOn(fakeBrowser.extension, "isAllowedIncognitoAccess").mockResolvedValue(allowed as never);
}

async function status() {
  const reply = v.parse(BackgroundReplySchema, await send({ type: "workspace-status" }));
  if (!reply.ok) throw new Error(reply.error);
  return v.parse(WorkspaceStatusSchema, reply.result);
}

beforeEach(() => {
  fakeBrowser.reset();
  openWindowsWithTabs();
  allowIncognito(true);
  send = background();
});

// The Node projects share a worker, so a spy left on the fake browser would reach other files.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("workspace-status", () => {
  test("reports access, the managed window, and foreign windows by id and tab count", async () => {
    expect(await status()).toEqual({ access: true, foreign: [], busy: false });
    await send({ type: "workspace-start", url: TARGET });
    const foreign = await openIncognitoWindow();
    const { managed, ...rest } = await status();
    expect(managed).toEqual(await managedWindowRepository.read());
    expect(rest).toEqual({ access: true, foreign: [{ id: foreign, tabCount: 1 }], busy: false });
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
    let finish = () => {};
    const navigation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(fakeBrowser.tabs, "update").mockReturnValueOnce(navigation as never);
    const first = send({ type: "workspace-start", url: TARGET });
    await vi.waitFor(() => expect(fakeBrowser.tabs.update).toHaveBeenCalled());
    expect(await status()).toMatchObject({ busy: true });
    const busy = {
      ok: false,
      error: "RECnRun is busy with another Incognito workspace operation.",
    };
    expect(await send({ type: "workspace-start", url: TARGET })).toEqual(busy);
    const closeAndStart = { type: "workspace-close-and-start", url: TARGET, windowIds: [] };
    expect(await send(closeAndStart)).toEqual(busy);
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
