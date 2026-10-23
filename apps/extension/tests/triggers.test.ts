import type { RecordingSession } from "@recnrun/domain";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { SessionStore } from "@/background/open-session";
import {
  createSessionListener,
  createTriggers,
  DASHBOARD_MENU_ITEM,
  PAGE_MENU_ITEM,
} from "@/background/triggers";
import type { TriggerTargets } from "@/background/triggers";
import { floatSessionMessage, openSessionMessage } from "@/messaging/session-protocol";

const EXTENSION = "chrome-extension://test-id/";
const SESSION = `${EXTENSION}session.html`;
const DASHBOARD = `${EXTENSION}dashboard.html`;

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function memoryStore(): SessionStore & { current: () => RecordingSession | null } {
  let session: RecordingSession | null = null;
  return {
    read: async () => session,
    write: async (next) => {
      session = next;
    },
    current: () => session,
  };
}

function targets(panelOpen = false): TriggerTargets & { store: ReturnType<typeof memoryStore> } {
  return {
    sessionUrl: SESSION,
    dashboardUrl: DASHBOARD,
    store: memoryStore(),
    panelOpen: async () => panelOpen,
  };
}

const page = () => fakeBrowser.tabs.create({ url: "https://shop.example/" });

test("a trigger records its tab with the session's pane", async () => {
  const setup = targets();
  const tab = await page();
  await createTriggers(setup).openSession(tab);
  expect(setup.store.current()?.tabId).toBe(tab.id);
  expect(await fakeBrowser.tabs.query({ url: SESSION })).toHaveLength(1);
});

test("a trigger does nothing while the session floats in a PiP window", async () => {
  const setup = targets(true);
  await createTriggers(setup).openSession(await page());
  expect(setup.store.current()).toBeNull();
  expect(await fakeBrowser.tabs.query({ url: SESSION })).toHaveLength(0);
});

test("every dashboard trigger opens another dashboard tab", async () => {
  const triggers = createTriggers(targets());
  await triggers.openDashboard();
  await triggers.openDashboard();
  expect(await fakeBrowser.tabs.query({ url: DASHBOARD })).toHaveLength(2);
});

/** The listener as Chrome calls it; extension pages send with their own URL. */
function send(message: unknown, sender: Partial<Browser.runtime.MessageSender>) {
  const setup = targets();
  const triggers = createTriggers(setup);
  const openSession = vi.spyOn(triggers, "openSession");
  const listener = createSessionListener(triggers, setup.store, EXTENSION);
  const answered = listener(message, { id: fakeBrowser.runtime.id, ...sender });
  return { setup, openSession, answered };
}

test("a dashboard's open-session request runs the trigger on that tab", async () => {
  const tab = await page();
  const { openSession, answered } = send(openSessionMessage(tab.id ?? -1), { url: DASHBOARD });
  expect(answered).toBe(false);
  await expect.poll(() => openSession.mock.calls[0]?.[0]?.id).toBe(tab.id);
});

test("a dashboard's float-session request records the tab without a pane", async () => {
  const tab = await page();
  const { setup } = send(floatSessionMessage(tab.id ?? -1), { url: `${DASHBOARD}#/` });
  await expect.poll(() => setup.store.current()?.tabId).toBe(tab.id);
  expect(await fakeBrowser.tabs.query({ url: SESSION })).toHaveLength(0);
});

test("ignores requests from content scripts, other extensions, and malformed messages", async () => {
  const tab = await page();
  const request = floatSessionMessage(tab.id ?? -1);
  const sent = [
    send(request, { url: "https://recnrun.com/" }),
    send(request, { url: DASHBOARD, id: "other-extension" }),
    send({ type: "float-session", tabId: "7" }, { url: DASHBOARD }),
    send({ type: "delete-everything" }, { url: DASHBOARD }),
  ];
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const { setup, openSession } of sent) {
    expect(setup.store.current()).toBeNull();
    expect(openSession).not.toHaveBeenCalled();
  }
});

test("offers Open RECnRun on every page and frame, and Dashboard on the toolbar icon", () => {
  expect(PAGE_MENU_ITEM).toEqual({
    id: "open-recnrun",
    title: "Open RECnRun",
    contexts: ["page", "frame"],
  });
  expect(DASHBOARD_MENU_ITEM).toEqual({
    id: "open-dashboard",
    title: "Dashboard",
    contexts: ["action"],
  });
});
