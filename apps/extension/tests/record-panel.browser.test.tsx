import { render } from "preact";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { Mock } from "vite-plus/test";
import { RecordControls } from "@/dashboard/panel/RecordControls";
import type { RecordSurface } from "@/dashboard/panel/RecordControls";
import { StandalonePanel } from "@/dashboard/panel/RecordPanel";
import type { RecordingStore } from "@/dashboard/panel/recording";
import { startDashboard } from "@/dashboard/start";
import { closePanelMessage, openPanelMessage } from "@/messaging/frame-protocol";
import { DASHBOARD_LOCK, holdLock, isHeld, PANEL_LOCK } from "@/messaging/view-locks";
import type { DocumentPictureInPicture } from "@/pip/document-pip";
import { dashboardData, memoryRecordingStore } from "./dashboard-data";

/** Stands in for the PiP window with a same-origin frame, whose document Preact can portal into. */
interface Opened {
  window: Window;
  close: Mock<() => void>;
}

/** The PiP window opened n-th, failing the test when there is none. */
function nth(opened: Opened[], index: number): Opened {
  const entry = opened[index];
  if (!entry) throw new Error(`No PiP window #${index} was opened.`);
  return entry;
}

function framePip(): DocumentPictureInPicture & { opened: Opened[] } {
  const opened: Opened[] = [];
  return {
    window: null,
    opened,
    async requestWindow() {
      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      const pipWindow = iframe.contentWindow;
      if (!pipWindow) throw new Error("The frame did not load.");
      const close = vi.fn(() => iframe.remove());
      pipWindow.close = close;
      opened.push({ window: pipWindow, close });
      return pipWindow;
    },
  };
}

/** A dashboard tab that records what the panel asks of it. */
const idleTab = () => ({ leaveSplit: vi.fn(async () => {}), focus: vi.fn(async () => {}) });

function mount(surface: RecordSurface, store: RecordingStore = memoryRecordingStore()) {
  const root = document.createElement("div");
  document.body.append(root);
  render(<RecordControls surface={surface} store={store} />, root);
  return root;
}

const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll("button")].find((each) => each.textContent === name);

const panelText = (scope: ParentNode) =>
  scope.querySelector('section[aria-label="Recording panel"]')?.textContent;

afterEach(() => {
  // Unmounting frees the locks that views still showing a panel hold.
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
  document.head.querySelector("link[data-test]")?.remove();
});

test("without PiP the controls record, pause, and stop in the tab", async () => {
  const root = mount({ kind: "inline" });
  button(root, "Record")?.click();
  await expect.poll(() => panelText(root)).toContain("Recording 00:00");
  button(root, "Pause")?.click();
  await expect.poll(() => panelText(root)).toContain("Paused");
  button(root, "Resume")?.click();
  await expect.poll(() => panelText(root)).toContain("Recording");
  button(root, "Stop")?.click();
  await expect.poll(() => button(root, "Record")).toBeDefined();
});

test("a top-level dashboard renders the panel into its PiP window with its styles", async () => {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/x.css" });
  link.dataset.test = "";
  document.head.append(link);
  const pip = framePip();
  const tab = idleTab();
  const root = mount({ kind: "window", pip, tab });

  button(root, "Record")?.click();
  await expect.poll(() => pip.opened.length).toBe(1);
  const pipDocument = nth(pip.opened, 0).window.document;
  await expect.poll(() => panelText(pipDocument)).toContain("Recording");
  expect(tab.leaveSplit).toHaveBeenCalledOnce();
  expect(pipDocument.head.querySelector("link")?.getAttribute("href")).toBe(
    `${location.origin}/x.css`,
  );

  button(pipDocument, "Stop")?.click();
  await expect.poll(() => button(root, "Record")).toBeDefined();
  expect(nth(pip.opened, 0).close).toHaveBeenCalled();
  expect(tab.focus).toHaveBeenCalled();
});

test("closing the PiP window keeps recording until the panel shows again", async () => {
  const pip = framePip();
  const root = mount({ kind: "window", pip, tab: idleTab() });
  button(root, "Record")?.click();
  await expect.poll(() => pip.opened.length).toBe(1);

  nth(pip.opened, 0).window.dispatchEvent(new Event("pagehide"));
  await expect.poll(() => root.textContent).toContain("Recording 00:00");
  await expect.poll(() => button(root, "Show the panel")).toBeDefined();
  button(root, "Show the panel")?.click();
  await expect.poll(() => pip.opened.length).toBe(2);
  await expect.poll(() => panelText(nth(pip.opened, 1).window.document)).toContain("Recording");

  nth(pip.opened, 1).window.dispatchEvent(new Event("pagehide"));
  await expect.poll(() => button(root, "Stop")).toBeDefined();
  button(root, "Stop")?.click();
  await expect.poll(() => button(root, "Record")).toBeDefined();
});

test("a refused PiP window shows why", async () => {
  const pip: DocumentPictureInPicture = {
    window: null,
    requestWindow: () => Promise.reject(new Error("Document PiP requires user activation")),
  };
  const root = mount({ kind: "window", pip, tab: idleTab() });
  button(root, "Record")?.click();
  await expect
    .poll(() => root.querySelector('[role="alert"]')?.textContent)
    .toBe("Document PiP requires user activation");
});

test("views sharing a store show one recording and stopping it anywhere closes the PiP", async () => {
  const store = memoryRecordingStore();
  const pip = framePip();
  const tab = mount({ kind: "window", pip, tab: idleTab() }, store);
  const requestPanel = vi.fn();
  const site = mount({ kind: "parent", requestPanel }, store);

  button(site, "Record")?.click();
  expect(requestPanel).toHaveBeenCalledOnce();
  await expect.poll(() => tab.textContent).toContain("Recording 00:00");
  button(tab, "Show the panel")?.click();
  await expect.poll(() => pip.opened.length).toBe(1);

  button(site, "Stop")?.click();
  await expect.poll(() => button(tab, "Record")).toBeDefined();
  await expect.poll(() => nth(pip.opened, 0).close.mock.calls.length).toBe(1);
});

test("while one view's panel floats, the others say so instead of opening a second one", async () => {
  const store = memoryRecordingStore();
  const pip = framePip();
  const owner = mount({ kind: "window", pip, tab: idleTab() }, store);
  const other = mount({ kind: "window", pip: framePip(), tab: idleTab() }, store);
  const site = mount({ kind: "parent", requestPanel: vi.fn() }, store);

  button(owner, "Record")?.click();
  await expect.poll(() => pip.opened.length).toBe(1);
  for (const view of [other, site]) {
    await expect.poll(() => view.textContent).toContain("The panel is open in a floating window.");
    expect(button(view, "Show the panel")).toBeUndefined();
  }

  expect(await isHeld(PANEL_LOCK)).toBe(true);

  nth(pip.opened, 0).window.dispatchEvent(new Event("pagehide"));
  await expect.poll(() => isHeld(PANEL_LOCK)).toBe(false);
  for (const view of [owner, other, site]) {
    await expect.poll(() => button(view, "Show the panel")).toBeDefined();
  }
  button(owner, "Stop")?.click();
});

test("while the dashboard tab is open, the site neither records nor keeps its panel", async () => {
  const store = memoryRecordingStore();
  const release = holdLock(DASHBOARD_LOCK);
  const site = mount({ kind: "parent", requestPanel: vi.fn() }, store);
  await expect.poll(() => site.textContent).toBe("Recording is controlled from the RECnRun tab.");
  expect(button(site, "Record")).toBeUndefined();

  await store.write({ status: "paused", banked: 42_000, since: 0 });
  await expect.poll(() => site.textContent).toContain("Paused 00:42");
  expect(site.querySelectorAll("button")).toHaveLength(0);
  const close = vi.fn();
  const panel = document.body.appendChild(document.createElement("div"));
  render(<StandalonePanel store={store} onStop={close} />, panel);
  await expect.poll(() => close.mock.calls.length).toBeGreaterThan(0);
  // Closing the PiP window would unload the panel, which frees its lock.
  render(null, panel);

  release();
  await expect.poll(() => button(site, "Show the panel")).toBeDefined();
});

test("a framed dashboard asks the site for the panel and the panel view asks it to close", async () => {
  const posted: unknown[] = [];
  window.addEventListener("message", (event) => posted.push(event.data));
  const framed = (search: string) =>
    Object.assign(new EventTarget(), {
      parent: window,
      document,
      location: { ancestorOrigins: [location.origin], search },
    }) as unknown as Window;
  const data = dashboardData();

  const dashboard = document.createElement("div");
  startDashboard(dashboard, data, framed(""));
  button(dashboard, "Record")?.click();
  await expect.poll(() => posted).toContainEqual(openPanelMessage());

  const panel = document.createElement("div");
  startDashboard(panel, data, framed("?view=panel"));
  await expect.poll(() => panelText(panel)).toContain("Recording");
  await expect.poll(() => dashboard.textContent).toContain("Recording");
  button(panel, "Stop")?.click();
  await expect.poll(() => posted).toContainEqual(closePanelMessage());
  await expect.poll(() => button(dashboard, "Record")).toBeDefined();
});
