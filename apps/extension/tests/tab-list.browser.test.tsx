import { render } from "preact";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { startDashboard } from "@/dashboard/start";
import { openPanelMessage, panelClosedMessage } from "@/messaging/frame-protocol";
import { returnToDashboardMessage, startSessionMessage } from "@/messaging/session-protocol";
import type { WorkspaceStatus } from "@/messaging/workspace-protocol";
import type { ExtensionServices } from "@/views/extension-services";
import { CONTROL_LOCK, tryHoldLock } from "@/views/view-locks";
import {
  NO_INCOGNITO_WINDOW,
  fakeBackground,
  fakeExtension,
  memoryRecordingStore,
} from "./fake-extension";
import { DOCS, PRIVATE, SHOP, fakeIncognito, fakeTabs } from "./fake-tabs";
import { button } from "./queries";

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

/** The workspace status with `tabId` as the managed window's tab, the only one RECnRun records. */
const managing = (tabId: number, status: "active" | "closed" = "active"): WorkspaceStatus => ({
  ...NO_INCOGNITO_WINDOW,
  managed: { generation: 1, windowId: 1, tabId, status },
});

function mount(
  services: Partial<ExtensionServices> = {},
  status: () => WorkspaceStatus = () => managing(SHOP.id),
) {
  const tabs = fakeTabs({ tabs: [SHOP, DOCS] });
  const { send, sent } = fakeBackground(status);
  const page = framedPage();
  const root = document.body.appendChild(document.createElement("div"));
  startDashboard(root, fakeExtension({ tabs: tabs.source, send, ...services }), page);
  return { root, sent, tabs, page };
}

const posted: unknown[] = [];
const onMessage = (event: MessageEvent) => posted.push(event.data);

const item = (root: HTMLElement, title: string) =>
  root.querySelector<HTMLElement>(`li[aria-label="${title}"]`) ?? undefined;
/** The session's buttons; the address button belongs to the Incognito workspace's tests. */
const buttons = (scope: HTMLElement | undefined) =>
  [...(scope?.querySelectorAll("button") ?? [])]
    .map((each) => each.textContent)
    .filter((name) => name !== "Use this tab's address");
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

test("lists the browser's tabs as they change; only the workspace's tab can start a session", async () => {
  const { root, tabs } = mount();
  await expect.poll(() => buttons(item(root, "Shop"))).toEqual(["Record"]);
  expect(buttons(item(root, "Docs"))).toEqual([]);
  expect(root.querySelector("aside h2")?.textContent).toBe("Tabs");
  expect(item(root, "Shop")?.textContent).toContain("https://shop.example/");

  tabs.change({ tabs: [DOCS] });
  await expect.poll(() => item(root, "Shop")).toBeUndefined();
  expect(buttons(item(root, "Docs"))).toEqual([]);
});

test("Record follows the managed tab while its window is open, and no other tab offers it", async () => {
  let status = managing(PRIVATE.id);
  const incognito = fakeIncognito(true);
  const tabs = fakeTabs({ tabs: [SHOP, PRIVATE] }).source;
  const { root } = mount({ tabs, incognito: incognito.access }, () => status);
  await expect.poll(() => buttons(item(root, "Private"))).toEqual(["Record"]);
  expect(buttons(item(root, "Shop"))).toEqual([]);

  status = managing(PRIVATE.id, "closed");
  incognito.windowsChanged();
  await expect.poll(() => buttons(item(root, "Private"))).toEqual([]);
  status = NO_INCOGNITO_WINDOW;
  incognito.windowsChanged();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(buttons(item(root, "Private"))).toEqual([]);
  expect(buttons(item(root, "Shop"))).toEqual([]);
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

test("the dashboard listens to the frame channel once for its route and its control", async () => {
  const page = framedPage();
  const added = vi.spyOn(page, "addEventListener");
  const root = document.body.appendChild(document.createElement("div"));
  startDashboard(root, fakeExtension({ tabs: fakeTabs({ tabs: [SHOP] }).source }), page);
  await expect.poll(() => item(root, "Shop")).toBeDefined();
  expect(added.mock.calls.filter(([type]) => type === "message")).toHaveLength(1);
});

test("a session the background cannot start frees the control and shows the error", async () => {
  const send = async (request: { type: string }) =>
    request.type === "workspace-status"
      ? { ok: true as const, result: managing(SHOP.id) }
      : { ok: false as const, error: "Quota exceeded" };
  const { root } = mount({ send });
  await expect.poll(() => button(item(root, "Shop") ?? root, "Record")).toBeDefined();
  button(item(root, "Shop") ?? root, "Record")?.click();

  await expectControlFree();
  expect(alertText(root)).toBe("Quota exceeded");
  expect(buttons(item(root, "Shop"))).toEqual(["Record"]);
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
  await expect.poll(() => buttons(item(root, "Shop"))).toEqual(["Record"]);
  expect(buttons(item(root, "Docs"))).toEqual([]);
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
  await expect.poll(() => button(item(second.root, "Shop") ?? second.root, "Record")).toBeDefined();
  button(item(first.root, "Shop") ?? first.root, "Record")?.click();
  button(item(second.root, "Shop") ?? second.root, "Record")?.click();

  await expect.poll(() => alertText(second.root)).toBe("Another RECnRun tab controls the session.");
  expect(first.sent).toEqual([startSessionMessage(SHOP.id)]);
  expect(second.sent).toEqual([]);
  closePanel(first.page);
  await expectControlFree();
});

test("marks incognito tabs, shows only the icons it may load, and records the managed one", async () => {
  const shop = { ...SHOP, favicon: "data:image/png;base64,AA==" };
  const tabs = fakeTabs({ tabs: [shop, PRIVATE] }).source;
  const { root, sent, page } = mount({ tabs }, () => managing(PRIVATE.id));
  await expect.poll(() => buttons(item(root, "Private"))).toEqual(["Record"]);
  expect(buttons(item(root, "Shop"))).toEqual([]);
  expect(item(root, "Private")?.textContent).toContain("Incognito");
  expect(item(root, "Shop")?.textContent).not.toContain("Incognito");
  expect(item(root, "Shop")?.querySelector("img")?.getAttribute("src")).toBe(shop.favicon);
  expect(item(root, "Private")?.querySelector("img")).toBeNull();
  expect(item(root, "Private")?.querySelector("[title]")?.getAttribute("title")).toBe(PRIVATE.url);

  button(item(root, "Private") ?? root, "Record")?.click();
  await expect.poll(() => sent).toEqual([startSessionMessage(PRIVATE.id)]);
  closePanel(page);
  await expectControlFree();
});

const banner = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('section[aria-labelledby="incognito-heading"]') ?? undefined;

test("without incognito access, a banner opens RECnRun's details", async () => {
  const incognito = fakeIncognito(false);
  const { root } = mount({ incognito: incognito.access });
  await expect.poll(() => banner(root)?.textContent).toContain("Enable Incognito Mode");
  expect(banner(root)?.textContent).toContain(
    "Open the extension settings and enable “Allow in Incognito”.",
  );
  button(root, "Open Extension Config")?.click();
  await expect.poll(() => incognito.settings).toHaveLength(1);
});

test("the tabs wait for the incognito answer, and the banner lands above them", async () => {
  let report = (_allowed: boolean) => {};
  const access = {
    ...fakeIncognito(false).access,
    allowed: () => new Promise<boolean>((resolve) => (report = resolve)),
  };
  const { root } = mount({ incognito: access });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(root.querySelector("aside ul")).toBeNull();
  expect(banner(root)).toBeUndefined();

  report(false);
  await expect.poll(() => buttons(item(root, "Shop"))).toEqual(["Record"]);
  const list = root.querySelector("aside ul");
  expect(list && banner(root)?.compareDocumentPosition(list)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

test("details Chrome refuses to open are an alert", async () => {
  const access = {
    ...fakeIncognito(false).access,
    openSettings: async () => {
      throw new Error("Cannot open chrome://extensions.");
    },
  };
  const { root } = mount({ incognito: access });
  await expect.poll(() => button(root, "Open Extension Config")).toBeDefined();
  button(root, "Open Extension Config")?.click();
  await expect.poll(() => alertText(root)).toContain("Cannot open chrome://extensions.");
});

test("an access Chrome fails to report shows no banner", async () => {
  const access = {
    ...fakeIncognito(false).access,
    allowed: async () => Promise.reject(new Error("Extension context invalidated.")),
  };
  const { root } = mount({ incognito: access });
  await expect.poll(() => item(root, "Shop")).toBeDefined();
  expect(banner(root)).toBeUndefined();
});

test("only a framed dashboard holds the site tabs' ports", async () => {
  let held = 0;
  const { root } = mount({ holdSitePorts: () => (held += 1) });
  await expect.poll(() => root.querySelector("main")).not.toBeNull();
  expect(held).toBe(1);
});

test("opened on its own, outside the site, the dashboard points to the site", () => {
  const root = document.body.appendChild(document.createElement("div"));
  const page = Object.assign(new EventTarget(), {
    document,
    location: { ancestorOrigins: [], search: "" },
  }) as unknown as Window;
  startDashboard(root, fakeExtension(), page);
  expect(root.querySelector('[role="status"]')?.textContent).toBe(
    "Open recnrun.com to use RECnRun.",
  );
  expect(root.querySelector("aside")).toBeNull();
});
