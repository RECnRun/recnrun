import { afterEach, expect, test, vi } from "vite-plus/test";
import { servePanelRequests } from "@/content/panel-window";
import { closePanelMessage, openPanelMessage } from "@/messaging/frame-protocol";

const EXTENSION = "chrome-extension://test-id";
const SESSION = `${EXTENSION}/session.html`;

function frame(): Window {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  if (!iframe.contentWindow) throw new Error("The frame did not load.");
  return iframe.contentWindow;
}

/** A site page whose PiP API hands out same-origin frames instead of PiP windows. */
function sitePage(dashboard: HTMLIFrameElement) {
  const opened: { window: Window; close: () => void }[] = [];
  const page = Object.assign(new EventTarget(), {
    documentPictureInPicture: {
      window: null,
      requestWindow: async () => {
        const pipWindow = frame();
        const close = vi.fn();
        pipWindow.close = close;
        opened.push({ window: pipWindow, close });
        return pipWindow;
      },
    },
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
