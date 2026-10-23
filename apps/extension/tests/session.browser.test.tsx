import { render } from "preact";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { closePanelMessage } from "@/messaging/frame-protocol";
import { isHeld, PANEL_LOCK } from "@/messaging/view-locks";
import type { DocumentPictureInPicture } from "@/pip/document-pip";
import { SessionPane } from "@/session/SessionPane";
import { startSession } from "@/session/start";
import type { RecordingStore } from "@/views/recording";
import { memoryRecordingStore } from "./dashboard-data";
import { button, framePip, nth, panelText, refusingPip } from "./frame-pip";

/** The pane's tab, which records what the session asks of it. */
const paneTab = () => ({
  leaveSplit: vi.fn(async () => {}),
  focus: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
});

async function runningStore(): Promise<RecordingStore> {
  const store = memoryRecordingStore();
  await store.write({ tabId: 7, status: "recording", banked: 0, since: Date.now() });
  return store;
}

function mount(store: RecordingStore, tab = paneTab(), pip?: DocumentPictureInPicture) {
  const root = document.body.appendChild(document.createElement("div"));
  render(<SessionPane store={store} tab={tab} pip={pip} />, root);
  return root;
}

/** A session page framed by `ancestor`, as a PiP window or a hostile page would frame it. */
function framedPage(ancestor: string, origin = location.origin) {
  return Object.assign(new EventTarget(), {
    parent: window,
    document,
    location: { ancestorOrigins: [ancestor], origin },
  }) as unknown as Window;
}

afterEach(() => {
  // Unmounting frees the locks that views still showing a panel hold.
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
  document.head.querySelector("link[data-test]")?.remove();
});

test("with no session the page says so and links to a new dashboard tab", async () => {
  const root = mount(memoryRecordingStore());
  await expect
    .poll(() => root.querySelector('[role="status"]')?.textContent)
    .toBe("No recording is running.");
  const link = root.querySelector("a");
  expect(link?.getAttribute("href")).toBe("/dashboard.html");
  expect(link?.target).toBe("_blank");
  expect(button(root, "Float")).toBeUndefined();
});

test("the pane pauses and resumes the session, and closes its tab when stopped", async () => {
  const store = await runningStore();
  const tab = paneTab();
  const root = mount(store, tab);
  await expect.poll(() => panelText(root)).toContain("Recording 00:00");
  expect(root.textContent).toContain("Open the dashboard");
  button(root, "Pause")?.click();
  await expect.poll(() => panelText(root)).toContain("Paused");
  button(root, "Resume")?.click();
  await expect.poll(() => panelText(root)).toContain("Recording");
  button(root, "Stop")?.click();
  await expect.poll(() => tab.close.mock.calls.length).toBe(1);
  expect(await store.read()).toBeNull();
});

test("floating moves the controls into a styled PiP window and leaves the Split View", async () => {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/x.css" });
  link.dataset.test = "";
  document.head.append(link);
  const pip = framePip();
  const tab = paneTab();
  const root = mount(await runningStore(), tab, pip);

  await expect.poll(() => button(root, "Float")).toBeDefined();
  button(root, "Float")?.click();
  await expect.poll(() => pip.opened.length).toBe(1);
  const pipDocument = nth(pip.opened, 0).window.document;
  await expect.poll(() => panelText(pipDocument)).toContain("Recording");
  expect(panelText(root)).toBeUndefined();
  expect(root.textContent).toContain("The session floats in its own window.");
  expect(tab.leaveSplit).toHaveBeenCalledOnce();
  await expect.poll(() => isHeld(PANEL_LOCK)).toBe(true);
  expect(pipDocument.head.querySelector("link")?.getAttribute("href")).toBe(
    `${location.origin}/x.css`,
  );
  const logo = pipDocument.querySelector<HTMLImageElement>('section img[alt="RECnRun"]');
  await expect.poll(() => logo?.complete && logo.naturalWidth).toBeGreaterThan(0);

  button(pipDocument, "Stop")?.click();
  await expect.poll(() => tab.close.mock.calls.length).toBe(1);
  expect(nth(pip.opened, 0).close).toHaveBeenCalled();
  expect(tab.focus).not.toHaveBeenCalled();
});

test("closing the PiP window without Stop brings the session back beside its page", async () => {
  const pip = framePip();
  const tab = paneTab();
  const root = mount(await runningStore(), tab, pip);
  await expect.poll(() => button(root, "Float")).toBeDefined();
  button(root, "Float")?.click();
  await expect.poll(() => pip.opened.length).toBe(1);

  nth(pip.opened, 0).window.dispatchEvent(new Event("pagehide"));
  await expect.poll(() => panelText(root)).toContain("Recording");
  expect(tab.focus).toHaveBeenCalledOnce();
  await expect.poll(() => isHeld(PANEL_LOCK)).toBe(false);
  expect(button(root, "Float")).toBeDefined();
});

test("a refused PiP window shows why", async () => {
  const root = mount(
    await runningStore(),
    paneTab(),
    refusingPip("Document PiP requires user activation"),
  );
  await expect.poll(() => button(root, "Float")).toBeDefined();
  button(root, "Float")?.click();
  await expect
    .poll(() => root.querySelector('[role="alert"]')?.textContent)
    .toBe("Document PiP requires user activation");
});

test("framed in a PiP window, the session holds the panel lock and asks to close when it ends", async () => {
  const posted: unknown[] = [];
  const onMessage = (event: MessageEvent) => posted.push(event.data);
  window.addEventListener("message", onMessage);
  const store = await runningStore();
  const root = document.body.appendChild(document.createElement("div"));

  startSession(root, { recordings: store, tab: paneTab() }, framedPage(location.origin));
  await expect.poll(() => panelText(root)).toContain("Recording");
  expect(root.textContent).not.toContain("Open the dashboard");
  await expect.poll(() => isHeld(PANEL_LOCK)).toBe(true);

  button(root, "Stop")?.click();
  await expect.poll(() => posted).toContainEqual(closePanelMessage());
  window.removeEventListener("message", onMessage);
});

test("the session refuses to render inside a foreign ancestor", async () => {
  const root = document.body.appendChild(document.createElement("div"));
  startSession(
    root,
    { recordings: await runningStore(), tab: paneTab() },
    framedPage("https://evil.example"),
  );
  expect(root.textContent).toContain("https://evil.example");
  expect(panelText(root)).toBeUndefined();
});

test("a dashboard tab's PiP window, of the extension's own origin, is not a foreign ancestor", async () => {
  const extension = "chrome-extension://test-id";
  const root = document.body.appendChild(document.createElement("div"));
  startSession(
    root,
    { recordings: await runningStore(), tab: paneTab() },
    framedPage(extension, extension),
  );
  await expect.poll(() => panelText(root)).toContain("Recording");
});
