import { afterEach, expect, test, vi } from "vite-plus/test";
import { servePanelRequests } from "@/content/panel-window";
import { subscribeFrame } from "@/messaging/frame-channel";
import {
  closePanelMessage,
  openPanelMessage,
  panelClosedMessage,
} from "@/messaging/frame-protocol";

const EXTENSION = "chrome-extension://test-id";
const SESSION = `${EXTENSION}/session.html`;

function frame(): Window {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  if (!iframe.contentWindow) throw new Error("The frame did not load.");
  return iframe.contentWindow;
}

/** Counts the `message` listeners a window holds, as added and removed from now on. */
function messageListeners(target: Window): () => number {
  const added = vi.spyOn(target, "addEventListener");
  const removed = vi.spyOn(target, "removeEventListener");
  const messages = (calls: unknown[][]) => calls.filter(([type]) => type === "message").length;
  return () => messages(added.mock.calls) - messages(removed.mock.calls);
}

/** A site page whose PiP API hands out same-origin frames instead of PiP windows, or refuses. */
function sitePage(dashboard: HTMLIFrameElement, pip: "frames" | "refuses" | "missing" = "frames") {
  const opened: { window: Window; close: () => void; listeners: () => number }[] = [];
  const requestWindow = async () => {
    if (pip === "refuses") throw new Error("Document PiP requires user activation");
    const pipWindow = frame();
    const close = vi.fn();
    pipWindow.close = close;
    opened.push({ window: pipWindow, close, listeners: messageListeners(pipWindow) });
    return pipWindow;
  };
  const page = Object.assign(new EventTarget(), {
    documentPictureInPicture: pip === "missing" ? undefined : { window: null, requestWindow },
  }) as unknown as Window;
  servePanelRequests(dashboard, SESSION, EXTENSION, page);
  const send = (data: unknown, origin = EXTENSION, source = dashboard.contentWindow) =>
    page.dispatchEvent(new MessageEvent("message", { data, origin, source }));
  return { opened, send };
}

function first<T>(items: T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error("Nothing was opened.");
  return item;
}

const dashboardFrame = () => {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  return iframe;
};

afterEach(() => {
  document.body.replaceChildren();
});

test("opens a PiP window with the session page when the dashboard frame asks", async () => {
  const { opened, send } = sitePage(dashboardFrame());
  send(openPanelMessage());
  await expect.poll(() => opened.length).toBe(1);
  const panel = first(opened).window.document.querySelector("iframe");
  expect(panel?.title).toBe("RECnRun session");
  expect(panel?.getAttribute("src")).toBe(SESSION);
});

test("ignores requests from other origins, other windows, and malformed messages", async () => {
  const { opened, send } = sitePage(dashboardFrame());
  send(openPanelMessage(), "https://evil.example");
  send(openPanelMessage(), EXTENSION, window);
  send({ type: "open-panel" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(opened).toEqual([]);
});

test("closes the PiP window only when its own session asks", async () => {
  const { opened, send } = sitePage(dashboardFrame());
  send(openPanelMessage());
  await expect.poll(() => opened.length).toBe(1);
  const { window: pipWindow, close: closeSpy } = first(opened);
  const panel = pipWindow.document.querySelector("iframe")?.contentWindow;
  const close = (source: Window | null | undefined, origin = EXTENSION) =>
    pipWindow.dispatchEvent(
      new MessageEvent("message", { data: closePanelMessage(), origin, source }),
    );

  close(window);
  close(panel, "https://evil.example");
  pipWindow.dispatchEvent(
    new MessageEvent("message", { data: openPanelMessage(), origin: EXTENSION, source: panel }),
  );
  expect(closeSpy).not.toHaveBeenCalled();
  close(panel);
  expect(closeSpy).toHaveBeenCalledOnce();
});

test("the PiP window listens to its session through the frame channel, with one listener", async () => {
  const { opened, send } = sitePage(dashboardFrame());
  send(openPanelMessage());
  await expect.poll(() => opened.length).toBe(1);
  const { window: pipWindow, listeners } = first(opened);
  const panel = pipWindow.document.querySelector("iframe")?.contentWindow ?? null;
  expect(listeners()).toBe(1);

  // A second subscriber of the same window shares the channel's listener instead of adding one.
  const stop = subscribeFrame(pipWindow, panel, EXTENSION, {});
  expect(listeners()).toBe(1);
  stop();
  expect(listeners()).toBe(1);
});

/** The messages the content script posts to the dashboard frame, with their target origin. */
function toDashboard(dashboard: HTMLIFrameElement): unknown[][] {
  const seen: unknown[][] = [];
  const target = dashboard.contentWindow;
  if (!target) throw new Error("The frame did not load.");
  vi.spyOn(target, "postMessage").mockImplementation((...args: unknown[]) => void seen.push(args));
  return seen;
}

test("tells the dashboard once its PiP window closes", async () => {
  const dashboard = dashboardFrame();
  const told = toDashboard(dashboard);
  const { opened, send } = sitePage(dashboard);
  send(openPanelMessage());
  await expect.poll(() => opened.length).toBe(1);
  expect(told).toEqual([]);

  first(opened).window.dispatchEvent(new Event("pagehide"));
  await expect.poll(() => told).toEqual([[panelClosedMessage(), EXTENSION]]);
});

for (const pip of ["refuses", "missing"] as const) {
  test(`tells the dashboard when the PiP window ${pip === "refuses" ? "is refused" : "API is missing"}`, async () => {
    const dashboard = dashboardFrame();
    const told = toDashboard(dashboard);
    const { opened, send } = sitePage(dashboard, pip);
    send(openPanelMessage());
    await expect.poll(() => told).toEqual([[panelClosedMessage(), EXTENSION]]);
    expect(opened).toEqual([]);
  });
}
