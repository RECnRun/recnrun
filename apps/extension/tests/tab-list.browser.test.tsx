import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { startDashboard } from "@/dashboard/start";
import type { DashboardData } from "@/dashboard/start";
import { openPanelMessage, panelClosedMessage } from "@/messaging/frame-protocol";
import { returnToDashboardMessage, startSessionMessage } from "@/messaging/session-protocol";
import type { SessionRequest } from "@/messaging/session-protocol";
import { CONTROL_LOCK, tryHoldLock } from "@/messaging/view-locks";
import { dashboardData, memoryRecordingStore } from "./dashboard-data";
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

function mount(data: Partial<DashboardData> = {}) {
  const tabs = fakeTabs({ tabs: [SHOP, DOCS] });
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

  tabs.change({ tabs: [DOCS] });
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

test("marks incognito tabs, shows only the icons it may load, and records them alike", async () => {
  const shop = { ...SHOP, favicon: "data:image/png;base64,AA==" };
  const { root, sent, page } = mount({ tabs: fakeTabs({ tabs: [shop, PRIVATE] }).source });
  await expect.poll(() => buttons(item(root, "Private"))).toEqual(["Record"]);
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

test("without incognito access, a banner opens RECnRun's details and no window is offered", async () => {
  const incognito = fakeIncognito(false);
  const { root } = mount({ incognito: incognito.access });
  await expect.poll(() => banner(root)?.textContent).toContain("Enable Incognito Mode");
  expect(banner(root)?.textContent).toContain(
    "Open the extension settings and enable “Allow in Incognito”.",
  );
  expect(button(root, "New incognito window")).toBeUndefined();
  button(root, "Open Extension Config")?.click();
  await expect.poll(() => incognito.settings).toHaveLength(1);
});

test("the tabs wait for the incognito access, so the banner never pushes a Record button away", async () => {
  let report = (_allowed: boolean) => {};
  const access = {
    ...fakeIncognito(false).access,
    allowed: () => new Promise<boolean>((resolve) => (report = resolve)),
  };
  const { root } = mount({ incognito: access });
  await expect.poll(() => root.querySelector("aside h2")?.textContent).toBe("Tabs");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(item(root, "Shop")).toBeUndefined();

  report(false);
  await expect.poll(() => buttons(item(root, "Shop"))).toEqual(["Record"]);
  expect(banner(root)).toBeDefined();
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

test("an access Chrome fails to report shows neither the banner nor the window", async () => {
  const access = {
    ...fakeIncognito(false).access,
    allowed: async () => Promise.reject(new Error("Extension context invalidated.")),
  };
  const { root } = mount({ incognito: access });
  await expect.poll(() => item(root, "Shop")).toBeDefined();
  expect(banner(root)).toBeUndefined();
  expect(button(root, "New incognito window")).toBeUndefined();
});

test("with incognito access, a new incognito window opens without starting a session", async () => {
  const incognito = fakeIncognito(true);
  const { root, sent } = mount({ incognito: incognito.access });
  await expect.poll(() => button(root, "New incognito window")).toBeDefined();
  expect(banner(root)).toBeUndefined();
  button(root, "New incognito window")?.click();
  await expect.poll(() => incognito.opened).toHaveLength(1);
  expect(sent).toEqual([]);
});

test("a window Chrome refuses to open is an alert", async () => {
  const refused = fakeIncognito(true, async () => {
    throw new Error("Incognito mode is disabled.");
  });
  const { root } = mount({ incognito: refused.access });
  await expect.poll(() => button(root, "New incognito window")).toBeDefined();
  button(root, "New incognito window")?.click();
  await expect.poll(() => alertText(root)).toContain("Incognito mode is disabled.");
});

test("only a framed dashboard holds the site tabs' ports", async () => {
  let held = 0;
  const { root } = mount({ holdSitePorts: () => (held += 1) });
  await expect.poll(() => root.querySelector("main")).not.toBeNull();
  expect(held).toBe(1);
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
