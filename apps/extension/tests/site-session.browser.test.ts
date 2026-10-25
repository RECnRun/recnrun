import { afterEach, expect, test, vi } from "vite-plus/test";
import { ORPHANED_NOTICE } from "@/content/notice";
import { startSiteSession } from "@/content/site-session";
import type { SitePort } from "@/ports/site-port";

const PAGES = {
  dashboardUrl: "about:blank",
  sessionUrl: "about:blank",
  extensionOrigin: location.origin,
};

/** A port to the dashboard frames that the test disconnects, as Chrome does when RECnRun unloads. */
function fakePort() {
  const listeners: (() => void)[] = [];
  const port: SitePort = {
    name: "recnrun-site",
    onDisconnect: { addListener: (listener) => listeners.push(listener) },
  };
  return { port, disconnect: () => listeners.forEach((listener) => listener()) };
}

const orphanNotice = () =>
  [...document.querySelectorAll('[role="status"]')].find(
    (each) => each.textContent === ORPHANED_NOTICE,
  );

/** The site page, with its reloads counted instead of made, and a PiP window open or not. */
function siteSession(connect: () => SitePort, pipWindow: Window | null = null) {
  let connected = 0;
  let reloads = 0;
  const page = Object.assign(new EventTarget(), {
    document,
    history,
    location: { pathname: "/", search: "", hash: "", reload: () => (reloads += 1) },
    documentPictureInPicture: { window: pipWindow, requestWindow: () => Promise.reject() },
  }) as unknown as Window;
  startSiteSession(
    PAGES,
    () => {
      connected += 1;
      return connect();
    },
    page,
  );
  const frame = document.querySelector("iframe");
  if (!frame) throw new Error("The dashboard frame was not mounted.");
  return { frame, page, connections: () => connected, reloads: () => reloads };
}

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.overflow = "";
  Reflect.deleteProperty(document, "visibilityState");
});

/** Hides or shows the page as the browser would, without moving the real window. */
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

test("once its frame loads, the site holds a port, and asks for a reload when it drops", () => {
  const { port, disconnect } = fakePort();
  const { frame, connections } = siteSession(() => port);
  expect(connections()).toBe(0);
  frame.dispatchEvent(new Event("load"));
  frame.dispatchEvent(new Event("load"));
  expect(connections()).toBe(1);
  expect(orphanNotice()).toBeUndefined();

  disconnect();
  expect(orphanNotice()).toBeDefined();
  expect(document.querySelector("iframe")).toBeNull();
});

test("a site whose frame loads after RECnRun unloaded asks for a reload at once", () => {
  const { frame } = siteSession(() => {
    throw new Error("Extension context invalidated.");
  });
  frame.dispatchEvent(new Event("load"));
  expect(orphanNotice()).toBeDefined();
  expect(document.querySelector("iframe")).toBeNull();
});

test("an orphaned site reloads once the user comes back to it, as from chrome://extensions", () => {
  const { port, disconnect } = fakePort();
  const { frame, page, reloads } = siteSession(() => port);
  frame.dispatchEvent(new Event("load"));
  page.dispatchEvent(new Event("focus"));
  expect(reloads()).toBe(0);

  disconnect();
  expect(reloads()).toBe(0);
  page.dispatchEvent(new Event("focus"));
  expect(reloads()).toBe(1);
  expect(document.visibilityState).toBe("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(reloads()).toBe(2);
});

test("an orphaned site in a hidden tab waits to reload until the user can see it", () => {
  const { port, disconnect } = fakePort();
  const { frame, reloads } = siteSession(() => port);
  frame.dispatchEvent(new Event("load"));
  disconnect();

  setVisibility("hidden");
  expect(reloads()).toBe(0);
  setVisibility("visible");
  expect(reloads()).toBe(1);
});

test("orphaning closes the PiP window along with the frame, since RECnRun blanked both", () => {
  const { port, disconnect } = fakePort();
  const close = vi.fn();
  const { frame } = siteSession(() => port, { close } as unknown as Window);
  frame.dispatchEvent(new Event("load"));
  expect(close).not.toHaveBeenCalled();

  disconnect();
  expect(close).toHaveBeenCalledOnce();
  expect(document.querySelector("iframe")).toBeNull();
});
