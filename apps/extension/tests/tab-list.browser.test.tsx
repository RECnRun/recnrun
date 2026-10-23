import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import type { OpenTab, TabSource } from "@/dashboard/open-tabs";
import { startDashboard } from "@/dashboard/start";
import type { DashboardData } from "@/dashboard/start";
import { openPanelMessage } from "@/messaging/frame-protocol";
import { holdLock, PANEL_LOCK } from "@/messaging/view-locks";
import { floatSessionMessage, openSessionMessage } from "@/messaging/session-protocol";
import type { SessionRequest } from "@/messaging/session-protocol";
import type { DocumentPictureInPicture } from "@/pip/document-pip";
import { dashboardData, memoryRecordingStore } from "./dashboard-data";
import { button, framePip, nth, refusingPip } from "./frame-pip";

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

/** A top-level dashboard tab stand-in, with or without Document PiP. */
function topLevelPage(pip?: DocumentPictureInPicture) {
  const href = "chrome-extension://test-id/dashboard.html#/";
  const { pathname, hash, search } = new URL(href);
  return Object.assign(new EventTarget(), {
    document,
    history: { replaceState: () => {} },
    documentPictureInPicture: pip,
    location: { ancestorOrigins: [], href, origin: location.origin, pathname, hash, search },
  }) as unknown as Window;
}

function framedPage() {
  return Object.assign(new EventTarget(), {
    parent: window,
    document,
    location: { ancestorOrigins: [location.origin], search: "" },
  }) as unknown as Window;
}

function mount(page: Window, data: Partial<DashboardData> = {}) {
  const tabs = fakeTabs([SHOP, DOCS]);
  const sent: SessionRequest[] = [];
  const full = { ...dashboardData(), tabs: tabs.source, send: (r: SessionRequest) => sent.push(r) };
  const root = document.body.appendChild(document.createElement("div"));
  startDashboard(root, { ...full, ...data }, page);
  return { root, sent, tabs, recordings: full.recordings };
}

const item = (root: HTMLElement, title: string) =>
  root.querySelector<HTMLElement>(`li[aria-label="${title}"]`) ?? undefined;
const buttons = (scope: HTMLElement | undefined) =>
  [...(scope?.querySelectorAll("button") ?? [])].map((each) => each.textContent);

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("lists the browser's tabs as they change, each able to start a session", async () => {
  const { root, tabs } = mount(topLevelPage(framePip()));
  await expect.poll(() => buttons(item(root, "Shop"))).toEqual(["Record", "Float"]);
  expect(root.querySelector("aside h2")?.textContent).toBe("Tabs");
  expect(item(root, "Shop")?.textContent).toContain("https://shop.example/");

  tabs.change([DOCS]);
  await expect.poll(() => item(root, "Shop")).toBeUndefined();
  expect(buttons(item(root, "Docs"))).toEqual(["Record", "Float"]);
});

test("Record asks the background to split the session beside the tab", async () => {
  const { root, sent } = mount(topLevelPage());
  await expect.poll(() => buttons(item(root, "Shop"))).toEqual(["Record"]);
  button(item(root, "Shop") ?? root, "Record")?.click();
  expect(sent).toEqual([openSessionMessage(SHOP.id)]);
});

test("Float opens the session page in a PiP window, then records the tab", async () => {
  const pip = framePip();
  const { root, sent } = mount(topLevelPage(pip));
  await expect.poll(() => button(item(root, "Docs") ?? root, "Float")).toBeDefined();
  button(item(root, "Docs") ?? root, "Float")?.click();
  await expect.poll(() => sent).toEqual([floatSessionMessage(DOCS.id)]);
  const frame = nth(pip.opened, 0).window.document.querySelector("iframe");
  expect(frame?.title).toBe("RECnRun session");
  expect(frame?.getAttribute("src")).toBe("chrome-extension://test-id/session.html");
});

test("a refused PiP window shows why and records nothing", async () => {
  const { root, sent } = mount(topLevelPage(refusingPip("Document PiP requires user activation")));
  await expect.poll(() => button(item(root, "Shop") ?? root, "Float")).toBeDefined();
  button(item(root, "Shop") ?? root, "Float")?.click();
  await expect
    .poll(() => item(root, "Shop")?.querySelector('[role="alert"]')?.textContent)
    .toBe("Document PiP requires user activation");
  expect(sent).toEqual([]);
});

test("the recorded tab controls the session and the other tabs wait", async () => {
  const recordings = memoryRecordingStore();
  const { root, sent } = mount(topLevelPage(framePip()), { recordings });
  await recordings.write({ tabId: SHOP.id, status: "recording", banked: 0, since: Date.now() });

  await expect.poll(() => buttons(item(root, "Shop"))).toEqual(["Show", "Pause", "Stop"]);
  expect(item(root, "Shop")?.textContent).toContain("Recording 00:00");
  expect(buttons(item(root, "Docs"))).toEqual([]);

  button(item(root, "Shop") ?? root, "Show")?.click();
  expect(sent).toEqual([openSessionMessage(SHOP.id)]);
  button(item(root, "Shop") ?? root, "Pause")?.click();
  await expect.poll(() => item(root, "Shop")?.textContent).toContain("Paused");
  button(item(root, "Shop") ?? root, "Stop")?.click();
  await expect.poll(() => buttons(item(root, "Docs"))).toEqual(["Record", "Float"]);
});

test("while the session floats, the recorded tab says so instead of offering Show", async () => {
  const recordings = memoryRecordingStore();
  await recordings.write({ tabId: SHOP.id, status: "paused", banked: 42_000, since: 0 });
  const release = holdLock(PANEL_LOCK);
  const { root } = mount(topLevelPage(), { recordings });
  await expect.poll(() => buttons(item(root, "Shop"))).toEqual(["Resume", "Stop"]);
  expect(item(root, "Shop")?.textContent).toContain("The session floats in its own window.");
  expect(item(root, "Shop")?.textContent).toContain("Paused 00:42");

  release();
  await expect.poll(() => buttons(item(root, "Shop"))).toEqual(["Show", "Resume", "Stop"]);
});

test("a framed dashboard asks the site for the PiP window, then records the tab", async () => {
  const posted: unknown[] = [];
  const onMessage = (event: MessageEvent) => posted.push(event.data);
  window.addEventListener("message", onMessage);
  const { root, sent } = mount(framedPage());
  await expect.poll(() => button(item(root, "Shop") ?? root, "Float")).toBeDefined();
  button(item(root, "Shop") ?? root, "Float")?.click();
  await expect.poll(() => posted).toContainEqual(openPanelMessage());
  expect(sent).toEqual([floatSessionMessage(SHOP.id)]);
  button(item(root, "Shop") ?? root, "Record")?.click();
  expect(sent).toContainEqual(openSessionMessage(SHOP.id));
  window.removeEventListener("message", onMessage);
});

test("without the tabs API the dashboard lists no tab", async () => {
  const { root } = mount(topLevelPage(), { tabs: undefined });
  await expect.poll(() => root.querySelector("main")).not.toBeNull();
  expect(root.querySelector("aside")).toBeNull();
});
