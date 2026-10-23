import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { dashboardTab } from "@/dashboard/dashboard-tab";
import { showWorkspaceMessage } from "@/messaging/dashboard-protocol";

const DASHBOARD = "chrome-extension://test-id/dashboard.html";

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// fakeBrowser's remove looks up a window by the tab's id and throws, so this records the call.
const spyOnRemove = () => vi.spyOn(fakeBrowser.tabs, "remove").mockImplementation(() => {});

test("focus brings the dashboard tab and its window to the front", async () => {
  const me = await fakeBrowser.tabs.create({ url: DASHBOARD });
  await fakeBrowser.tabs.create({ url: "https://shop.example/", active: true });
  const focusWindow = vi.spyOn(fakeBrowser.windows, "update");

  await dashboardTab(async () => me).focus();
  expect((await fakeBrowser.tabs.get(me.id ?? -1)).active).toBe(true);
  expect(focusWindow).toHaveBeenCalledWith(me.windowId, { focused: true });
});

test("close removes the dashboard tab, and outside a tab neither call does anything", async () => {
  const me = await fakeBrowser.tabs.create({ url: DASHBOARD });
  const remove = spyOnRemove();
  const update = vi.spyOn(fakeBrowser.tabs, "update");

  await dashboardTab(async () => me).close();
  expect(remove).toHaveBeenCalledWith(me.id);
  await dashboardTab(async () => undefined).close();
  await dashboardTab(async () => undefined).focus();
  expect(remove).toHaveBeenCalledOnce();
  expect(update).not.toHaveBeenCalled();
});

test("shows the workspace the background sends to this tab, from this extension only", async () => {
  const me = await fakeBrowser.tabs.create({ url: DASHBOARD });
  const listener = vi.fn();
  const stop = dashboardTab(async () => me).onShowWorkspace(listener);
  const send = async (message: unknown, id: string) => {
    await fakeBrowser.runtime.onMessage.trigger(message, { id }, () => {}).then(() => undefined);
  };
  const own = fakeBrowser.runtime.id;

  await send(showWorkspaceMessage(me.id ?? -1, "https://b.example"), "evil-id");
  await send(showWorkspaceMessage((me.id ?? -1) + 1, "https://b.example"), own);
  await send({ type: "show-workspace", tabId: me.id, workspace: "javascript:alert(1)" }, own);
  await send(showWorkspaceMessage(me.id ?? -1, "https://b.example"), own);
  await send(showWorkspaceMessage(me.id ?? -1), own);
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
  expect(listener.mock.calls).toEqual([["https://b.example"], [undefined]]);

  stop();
  await send(showWorkspaceMessage(me.id ?? -1), own);
  expect(listener).toHaveBeenCalledTimes(2);
});
