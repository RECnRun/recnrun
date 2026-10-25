import { expect, test, vi } from "vite-plus/test";
import { subscribeFrame } from "@/messaging/frame-channel";
import type { FrameHandlers } from "@/messaging/frame-channel";
import { navigateMessage, panelClosedMessage, routeMessage } from "@/messaging/frame-protocol";

const SITE = "https://recnrun.com";
/** The window the subscriber expects messages from, as the site is to the dashboard frame. */
const SENDER = {} as Window;

/** An extension page that counts its `message` listeners and receives what the sender posts. */
class FakePage extends EventTarget {
  listeners = 0;

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (type === "message") this.listeners += 1;
    super.addEventListener(type, listener);
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (type === "message") this.listeners -= 1;
    super.removeEventListener(type, listener);
  }

  receive(data: unknown, origin = SITE, source: unknown = SENDER) {
    this.dispatchEvent(Object.assign(new Event("message"), { data, origin, source }));
  }
}

function subscribed(handlers: FrameHandlers = {}) {
  const page = new FakePage();
  const route = vi.fn();
  const panelClosed = vi.fn();
  const stop = subscribeFrame(page as unknown as Window, SENDER, SITE, {
    route,
    "panel-closed": panelClosed,
    ...handlers,
  });
  return { page, route, panelClosed, stop };
}

test("hands each message to the handler of its type and ignores the other types", () => {
  const { page, route, panelClosed } = subscribed();
  page.receive(routeMessage("/recordings/rec-login"));
  page.receive(navigateMessage("/recordings/rec-login"));
  page.receive({ type: "route", path: "/" });
  page.receive(routeMessage("//evil.example/x"));
  expect(route).toHaveBeenCalledExactlyOnceWith(routeMessage("/recordings/rec-login"));
  expect(panelClosed).not.toHaveBeenCalled();

  page.receive(panelClosedMessage());
  expect(panelClosed).toHaveBeenCalledOnce();
});

test("drops messages from another window or another origin", () => {
  const { page, route } = subscribed();
  page.receive(routeMessage("/"), "https://evil.example");
  page.receive(routeMessage("/"), SITE, {});
  page.receive(routeMessage("/"), SITE, null);
  expect(route).not.toHaveBeenCalled();
});

test("subscribers of one page share one listener, which goes with the last of them", () => {
  const first = subscribed();
  const page = first.page as unknown as Window;
  const route = vi.fn();
  const stop = subscribeFrame(page, SENDER, SITE, { route });
  expect(first.page.listeners).toBe(1);

  first.page.receive(routeMessage("/a"));
  expect(first.route).toHaveBeenCalledExactlyOnceWith(routeMessage("/a"));
  expect(route).toHaveBeenCalledExactlyOnceWith(routeMessage("/a"));

  first.stop();
  first.page.receive(routeMessage("/b"));
  expect(first.route).toHaveBeenCalledOnce();
  expect(route).toHaveBeenCalledTimes(2);
  expect(first.page.listeners).toBe(1);

  stop();
  expect(first.page.listeners).toBe(0);
  first.page.receive(routeMessage("/c"));
  expect(route).toHaveBeenCalledTimes(2);
});
