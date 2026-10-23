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

const urls = async () => (await fakeBrowser.tabs.query({})).map((tab) => tab.url);

test("a later dashboard tab hands its route to the earlier one and closes", async () => {
  const earlier = await fakeBrowser.tabs.create({
    url: `${DASHBOARD}?workspace=https%3A%2F%2Fa.example#/`,
  });
  const later = await fakeBrowser.tabs.create({
    url: `${DASHBOARD}#/recordings/rec-login`,
    active: true,
  });
  const remove = spyOnRemove();

  await dashboardTab(async () => later).yieldToEarlier(new URL(later.url ?? ""));
  expect(remove).toHaveBeenCalledWith(later.id);
  const kept = await fakeBrowser.tabs.get(earlier.id ?? -1);
  expect(kept.url).toBe(`${DASHBOARD}?workspace=https%3A%2F%2Fa.example#/recordings/rec-login`);
  expect(kept.active).toBe(true);
});

test("a later dashboard tab without a route only focuses the earlier one", async () => {
  const earlier = await fakeBrowser.tabs.create({ url: `${DASHBOARD}#/recordings/rec-login` });
  const later = await fakeBrowser.tabs.create({ url: DASHBOARD, active: true });
  const remove = spyOnRemove();

  await dashboardTab(async () => later).yieldToEarlier(new URL(DASHBOARD));
  expect(remove).toHaveBeenCalledWith(later.id);
  expect(await urls()).toContain(`${DASHBOARD}#/recordings/rec-login`);
  expect((await fakeBrowser.tabs.get(earlier.id ?? -1)).active).toBe(true);
});

test("the earliest dashboard tab, or one outside a tab, stays open", async () => {
  const first = await fakeBrowser.tabs.create({ url: DASHBOARD });
  await fakeBrowser.tabs.create({ url: `${DASHBOARD}#/` });
  await fakeBrowser.tabs.create({ url: "https://shop.example/" });

  await dashboardTab(async () => first).yieldToEarlier(new URL(DASHBOARD));
  await dashboardTab(async () => undefined).yieldToEarlier(new URL(DASHBOARD));
  expect(await urls()).toHaveLength(4);
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
