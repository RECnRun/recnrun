import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { startDashboard } from "@/dashboard/start";
import { returnToDashboardMessage, startSessionMessage } from "@/messaging/session-protocol";
import type { SessionRequest } from "@/messaging/session-protocol";
import { CONTROL_LOCK, tryHoldLock } from "@/views/view-locks";
import { fakeExtension, memoryRecordingStore } from "./fake-extension";
import { DOCS, SHOP, fakeTabs } from "./fake-tabs";
import { button, panelText } from "./queries";

/** A window for the PiP API to hand out: a frame of this page, closed by removing it. */
function pipWindow(): Window {
  const frame = document.body.appendChild(document.createElement("iframe"));
  const opened = frame.contentWindow;
  if (!opened) throw new Error("The frame has no window.");
  opened.close = () => {
    opened.dispatchEvent(new Event("pagehide"));
    frame.remove();
  };
  return opened;
}

/** A top-level dashboard tab stand-in, with the PiP API when `pip` is given. */
function tabPage(hash: string, pip?: () => Promise<Window>) {
  const api = pip && { window: null, requestWindow: pip };
  return Object.assign(new EventTarget(), {
    document,
    history,
    location: { ancestorOrigins: [], hash },
    documentPictureInPicture: api,
  }) as unknown as Window;
}

/** Mounts the dashboard on its own tab, whose start-session reply comes from `reply`. */
function mount(page: Window, reply: { ok: boolean; error?: string } = { ok: true }) {
  const store = memoryRecordingStore();
  const sent: SessionRequest[] = [];
  const send = async (request: SessionRequest) => {
    sent.push(request);
    if (request.type === "start-session" && reply.ok)
      await store.write({
        tabId: request.tabId,
        status: "recording",
        banked: 0,
        since: Date.now(),
      });
    return reply;
  };
  const tabs = fakeTabs({ tabs: [SHOP, DOCS] }).source;
  const root = document.body.appendChild(document.createElement("div"));
  startDashboard(root, fakeExtension({ recordings: store, tabs, send }), page);
  return { root, sent, store };
}

const recordShop = async (root: HTMLElement) => {
  const shop = () => root.querySelector<HTMLElement>(`li[aria-label="${SHOP.title}"]`);
  await expect.poll(() => shop() && button(shop() as HTMLElement, "Record")).toBeTruthy();
  button(shop() as HTMLElement, "Record")?.click();
};

/** Whether a view holds the control lock; taking it to check frees it again. */
async function controlFree(): Promise<boolean> {
  const release = await tryHoldLock(CONTROL_LOCK);
  release?.();
  return release !== undefined;
}

const title = document.title;

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
  document.title = title;
  document.head.querySelector('link[href="dashboard-test.css"]')?.remove();
});

test("opened on its own, the dashboard shows the route in its hash and titles its tab", async () => {
  const { root } = mount(tabPage("#/recordings/rec-login"));
  await expect
    .poll(() => root.querySelector("article.recording h3")?.textContent)
    .toBe("Log in as admin");
  await expect.poll(() => document.title).toBe("Log in as admin · RECnRun");
  expect(root.querySelector('a[href="#/"]')).not.toBeNull();
});

test("Record floats the session in the tab's own PiP window until it closes", async () => {
  const sheet = Object.assign(document.createElement("link"), { rel: "stylesheet" });
  sheet.setAttribute("href", "dashboard-test.css");
  document.head.append(sheet);
  const opened = pipWindow();
  const { root, sent } = mount(tabPage("", async () => opened));
  await recordShop(root);

  await expect.poll(() => panelText(opened.document)).toContain("Recording");
  expect(sent).toEqual([startSessionMessage(SHOP.id)]);
  expect(await controlFree()).toBe(false);
  // The stylesheets come along, or the window shows the panel unstyled.
  expect(opened.document.head.querySelectorAll("style, link").length).toBe(
    document.head.querySelectorAll('style, link[rel="stylesheet"]').length,
  );
  // A copied link keeps the address it loaded from, whatever the window resolves against.
  expect(opened.document.head.querySelector("link")?.getAttribute("href")).toBe(
    new URL("dashboard-test.css", location.href).href,
  );

  button(opened.document, "Stop")?.click();
  await expect.poll(controlFree).toBe(true);
  expect(sent).toEqual([startSessionMessage(SHOP.id), returnToDashboardMessage()]);
});

test("a session that cannot start closes the window and frees the control", async () => {
  const opened = pipWindow();
  const { root, sent } = mount(
    tabPage("", async () => opened),
    {
      ok: false,
      error: "The tab to record was closed.",
    },
  );
  await recordShop(root);
  await expect
    .poll(() => root.querySelector('[role="alert"]')?.textContent)
    .toBe("The tab to record was closed.");
  expect(opened.document.defaultView).toBeNull();
  expect(await controlFree()).toBe(true);
  expect(sent).toEqual([startSessionMessage(SHOP.id)]);
});

test("without the PiP API, Record starts the session and leaves the control free", async () => {
  const { root, sent, store } = mount(tabPage(""));
  await recordShop(root);
  await expect.poll(() => store.read()).toMatchObject({ tabId: SHOP.id });
  expect(await controlFree()).toBe(true);
  expect(sent).toEqual([startSessionMessage(SHOP.id)]);
});
