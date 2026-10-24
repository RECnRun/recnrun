import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import type { OpenTab, TabSource } from "@/dashboard/open-tabs";
import { startDashboard } from "@/dashboard/start";
import type { DashboardData } from "@/dashboard/start";
import { openPanelMessage, panelClosedMessage } from "@/messaging/frame-protocol";
import { returnToDashboardMessage, startSessionMessage } from "@/messaging/session-protocol";
import type { SessionRequest } from "@/messaging/session-protocol";
import { CONTROL_LOCK, tryHoldLock } from "@/messaging/view-locks";
import { dashboardData, memoryRecordingStore } from "./dashboard-data";
import { button } from "./queries";

const SHOP: OpenTab = { id: 7, title: "Shop", url: "https://shop.example/" };
const DOCS: OpenTab = { id: 8, title: "Docs", url: "https://docs.example/" };

/** Browser tabs the test can change, as the tabs API events would. */
function fakeTabs(initial: OpenTab[]) {
  let tabs = initial;
  const listeners = new Set<() => void>();
  const source: TabSource = {
    list: async () => tabs,
    watch: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  const change = (next: OpenTab[]) => {
    tabs = next;
    for (const listener of listeners) listener();
  };
  return { source, change };
}

/** A dashboard frame stand-in whose parent, the site, is this test page. */
function framedPage() {
  return Object.assign(new EventTarget(), {
    parent: window,
    document,
    location: { ancestorOrigins: [location.origin], search: "" },
  }) as unknown as Window;
}

/** What the site's content script would send the frame once the PiP window closes. */
const closePanel = (page: Window) =>
  page.dispatchEvent(
    new MessageEvent("message", {
      data: panelClosedMessage(),
      origin: location.origin,
      source: window,
    }),
  );

function mount(data: Partial<DashboardData> = {}) {
  const tabs = fakeTabs([SHOP, DOCS]);
  const sent: SessionRequest[] = [];
  const page = framedPage();
  const full = { ...dashboardData(), tabs: tabs.source, send: (r: SessionRequest) => sent.push(r) };
  const root = document.body.appendChild(document.createElement("div"));
  startDashboard(root, { ...full, ...data }, page);
  return { root, sent, tabs, page };
}

const posted: unknown[] = [];
const onMessage = (event: MessageEvent) => posted.push(event.data);

const item = (root: HTMLElement, title: string) =>
  root.querySelector<HTMLElement>(`li[aria-label="${title}"]`) ?? undefined;
const buttons = (scope: HTMLElement | undefined) =>
  [...(scope?.querySelectorAll("button") ?? [])].map((each) => each.textContent);
const alertText = (root: HTMLElement) => root.querySelector('[role="alert"]')?.textContent;
/** Waits until no dashboard holds the control lock, which each test leaves free. */
async function expectControlFree() {
  let release: (() => void) | undefined;
  await expect
    .poll(async () => {
      release = await tryHoldLock(CONTROL_LOCK);
      return release !== undefined;
    })
    .toBe(true);
  release?.();
}

const running = (tabId: number) => ({ tabId, status: "recording" as const, banked: 0, since: 0 });

afterEach(() => {
  window.removeEventListener("message", onMessage);
  // Unmounting stops the lock watchers; the tests release the locks they take.
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("lists the browser's tabs as they change, each able to start a session", async () => {
  const { root, tabs } = mount();
  await expect.poll(() => buttons(item(root, "Shop"))).toEqual(["Record"]);
  expect(root.querySelector("aside h2")?.textContent).toBe("Tabs");
  expect(item(root, "Shop")?.textContent).toContain("https://shop.example/");

  tabs.change([DOCS]);
  await expect.poll(() => item(root, "Shop")).toBeUndefined();
  expect(buttons(item(root, "Docs"))).toEqual(["Record"]);
});

test("Record takes the control, asks the site for the PiP window, and records the tab", async () => {
  window.addEventListener("message", onMessage);
  const { root, sent, page } = mount();
  await expect.poll(() => button(item(root, "Shop") ?? root, "Record")).toBeDefined();
  button(item(root, "Shop") ?? root, "Record")?.click();

  await expect.poll(() => sent).toEqual([startSessionMessage(SHOP.id)]);
  await expect.poll(() => posted).toContainEqual(openPanelMessage());
  expect(await tryHoldLock(CONTROL_LOCK)).toBeUndefined();
  await expect.poll(() => buttons(item(root, "Docs"))).toEqual([]);

  closePanel(page);
  await expect.poll(() => sent.at(-1)).toEqual(returnToDashboardMessage());
  await expectControlFree();
});

test("while another dashboard has the control, the recorded tab only shows the session", async () => {
  const recordings = memoryRecordingStore();
  await recordings.write({ tabId: SHOP.id, status: "paused", banked: 42_000, since: 0 });
  const release = await tryHoldLock(CONTROL_LOCK);
  const { root } = mount({ recordings });
  await expect
    .poll(() => item(root, "Shop")?.textContent)
    .toContain("The session floats in its own window.");
  expect(item(root, "Shop")?.textContent).toContain("Paused 00:42");
  expect(buttons(item(root, "Shop"))).toEqual([]);
  expect(buttons(item(root, "Docs"))).toEqual([]);

  release?.();
  await expect.poll(() => buttons(item(root, "Shop"))).toEqual(["Continue", "Stop"]);
});

test("a session left without control can be continued or stopped from any dashboard", async () => {
  const recordings = memoryRecordingStore();
  await recordings.write(running(SHOP.id));
  const { root, sent, page } = mount({ recordings });
  await expect.poll(() => buttons(item(root, "Shop"))).toEqual(["Continue", "Stop"]);
  expect(item(root, "Shop")?.textContent).toContain("Recording");
  expect(buttons(item(root, "Docs"))).toEqual([]);

  button(item(root, "Shop") ?? root, "Continue")?.click();
  await expect.poll(() => sent).toEqual([startSessionMessage(SHOP.id)]);
  closePanel(page);
  await expect.poll(() => buttons(item(root, "Shop"))).toEqual(["Continue", "Stop"]);

  button(item(root, "Shop") ?? root, "Stop")?.click();
  await expect.poll(() => buttons(item(root, "Docs"))).toEqual(["Record"]);
  expect(await recordings.read()).toBeNull();
});

test("a session whose tab closed stays until stopped, and only floats while controlled", async () => {
  const recordings = memoryRecordingStore();
  await recordings.write(running(99));
  const release = await tryHoldLock(CONTROL_LOCK);
  const { root } = mount({ recordings });
  await expect
    .poll(() => item(root, "Closed tab")?.textContent)
    .toContain("The session floats in its own window.");
  expect(buttons(item(root, "Closed tab"))).toEqual([]);
  expect(buttons(item(root, "Shop"))).toEqual([]);

  release?.();
  await expect.poll(() => buttons(item(root, "Closed tab"))).toEqual(["Stop"]);
  expect(item(root, "Closed tab")?.textContent).toContain("Recording");
  button(item(root, "Closed tab") ?? root, "Stop")?.click();
  await expect.poll(() => item(root, "Closed tab")).toBeUndefined();
  expect(await recordings.read()).toBeNull();
  expect(buttons(item(root, "Shop"))).toEqual(["Record"]);
});

test("of two dashboards starting at once, only one takes the control", async () => {
  const first = mount();
  const second = mount();
  await expect.poll(() => button(item(second.root, "Docs") ?? second.root, "Record")).toBeDefined();
  button(item(first.root, "Shop") ?? first.root, "Record")?.click();
  button(item(second.root, "Docs") ?? second.root, "Record")?.click();

  await expect.poll(() => alertText(second.root)).toBe("Another RECnRun tab controls the session.");
  expect(first.sent).toEqual([startSessionMessage(SHOP.id)]);
  expect(second.sent).toEqual([]);
  closePanel(first.page);
  await expectControlFree();
});

test("without the tabs API the dashboard lists no tab", async () => {
  const { root } = mount({ tabs: undefined });
  await expect.poll(() => root.querySelector("main")).not.toBeNull();
  expect(root.querySelector("aside")).toBeNull();
});

test("opened on its own, outside the site, the dashboard points to the site", () => {
  const root = document.body.appendChild(document.createElement("div"));
  const page = Object.assign(new EventTarget(), {
    document,
    location: { ancestorOrigins: [], search: "" },
  }) as unknown as Window;
  startDashboard(root, dashboardData(), page);
  expect(root.querySelector('[role="status"]')?.textContent).toBe(
    "Open recnrun.com to use RECnRun.",
  );
  expect(root.querySelector("aside")).toBeNull();
});
