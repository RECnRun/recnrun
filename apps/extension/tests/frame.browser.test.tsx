import { afterEach, expect, test, vi } from "vite-plus/test";
import { mountDashboardFrame } from "@/content/dashboard-frame";
import { INCOGNITO_NOTICE, ORPHANED_NOTICE, showNotice } from "@/content/notice";
import { watchForOrphaning } from "@/content/orphan-watch";
import { servePanelRequests } from "@/content/panel-window";
import { createFrameRouter } from "@/dashboard/router";
import { startDashboard } from "@/dashboard/start";
import { locationMessage, navigateMessage, routeMessage } from "@/messaging/frame-protocol";
import type { SitePort } from "@/ports/site-port";
import { dashboardData } from "./dashboard-data";

const startPath = location.pathname;

/** A dashboard frame stand-in whose parent is this test page. */
function framedPage(fields: object): Window {
  return Object.assign(
    new EventTarget(),
    { parent: window, document },
    fields,
  ) as unknown as Window;
}

function messagesTo(target: Window): unknown[] {
  const seen: unknown[] = [];
  target.addEventListener("message", (event) => seen.push(event.data));
  return seen;
}

/** Posts from the frame's own script, so the message's source is the frame. */
function postFromFrame(frame: Window, message: unknown) {
  const script = frame.document.createElement("script");
  script.textContent = `parent.postMessage(${JSON.stringify(message)}, "*")`;
  frame.document.body.append(script);
}

function mountedFrame(): Window {
  mountDashboardFrame("about:blank", location.origin);
  const frame = document.querySelector<HTMLIFrameElement>("iframe")?.contentWindow;
  if (!frame) throw new Error("The dashboard frame did not load.");
  return frame;
}

afterEach(() => {
  history.replaceState(null, "", startPath);
  document.body.replaceChildren();
  document.documentElement.style.overflow = "";
});

test("the frame router starts at the site path and reports navigation to the site", async () => {
  const page = framedPage({ location: { search: "?route=%2Frecordings%2Frec-login" } });
  const router = createFrameRouter(location.origin, page);
  expect(router.initialRoute).toBe("/recordings/rec-login");
  expect(router.href("/")).toBe(`${location.origin}/`);

  const posted = messagesTo(window);
  router.navigate("/recordings/rec-checkout");
  router.publish("/recordings/rec-checkout", "Checkout");
  await expect
    .poll(() => posted)
    .toEqual([
      navigateMessage("/recordings/rec-checkout"),
      locationMessage("/recordings/rec-checkout", "Checkout"),
    ]);
});

test("the frame router ignores bad routes and messages from anyone but the site", () => {
  const page = framedPage({ location: { search: "?route=https://evil.example/" } });
  const router = createFrameRouter(location.origin, page);
  expect(router.initialRoute).toBe("/");

  const seen: string[] = [];
  const stop = router.subscribe((path) => seen.push(path));
  const send = (data: unknown, origin: string) =>
    page.dispatchEvent(new MessageEvent("message", { data, origin, source: window }));
  send(routeMessage("/recordings/rec-checkout"), "https://evil.example");
  send({ type: "route", path: "/" }, location.origin);
  send(routeMessage("/recordings/rec-checkout"), location.origin);
  stop();
  send(routeMessage("/"), location.origin);
  expect(seen).toEqual(["/recordings/rec-checkout"]);
});

test("the frame router treats a protocol-relative path as no route at all", () => {
  const page = framedPage({ location: { search: "?route=//evil.example/x" } });
  const router = createFrameRouter(location.origin, page);
  expect(router.initialRoute).toBe("/");

  const seen: string[] = [];
  router.subscribe((path) => seen.push(path));
  page.dispatchEvent(
    new MessageEvent("message", {
      data: routeMessage("//evil.example/x"),
      origin: location.origin,
      source: window,
    }),
  );
  expect(seen).toEqual([]);
});

test("the content script never pushes a protocol-relative path from the dashboard", async () => {
  history.replaceState(null, "", "/recordings/rec-login");
  const frame = mountedFrame();
  const entries = history.length;

  postFromFrame(frame, navigateMessage("//evil.example/x"));
  postFromFrame(frame, locationMessage("/recordings/rec-login", "Log in"));
  await expect.poll(() => document.title).toBe("Log in");
  expect(location.pathname).toBe("/recordings/rec-login");
  expect(location.host).toBe(new URL(location.origin).host);
  expect(history.length).toBe(entries);
});

/** Resolves once this window handled every message posted to it so far. */
function postedMessagesHandled(): Promise<void> {
  const marker = `handled-${Math.random()}`;
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.data !== marker) return;
      window.removeEventListener("message", onMessage);
      resolve();
    };
    window.addEventListener("message", onMessage);
    window.postMessage(marker, "*");
  });
}

/** A mounted frame on a titled route, with what a forged message must leave alone. */
async function titledFrame() {
  history.replaceState(null, "", "/recordings/rec-login");
  const frame = mountedFrame();
  const entries = history.length;
  postFromFrame(frame, locationMessage("/recordings/rec-login", "Log in"));
  await expect.poll(() => document.title).toBe("Log in");
  return { frame, entries };
}

function expectUntouched(entries: number) {
  expect(location.pathname).toBe("/recordings/rec-login");
  expect(document.title).toBe("Log in");
  expect(history.length).toBe(entries);
}

test("the content script ignores frame messages posted by the site's own window", async () => {
  const { entries } = await titledFrame();
  // Script on the site posting what the dashboard frame would.
  window.postMessage(navigateMessage("/recordings/rec-checkout"), "*");
  window.postMessage(locationMessage("/recordings/rec-login", "Forged"), "*");
  await postedMessagesHandled();
  expectUntouched(entries);
});

test("the content script ignores frame messages from a foreign origin", async () => {
  const { frame, entries } = await titledFrame();
  const forged = (data: unknown) =>
    window.dispatchEvent(
      new MessageEvent("message", { data, origin: "https://evil.example", source: frame }),
    );
  forged(navigateMessage("/recordings/rec-checkout"));
  forged(locationMessage("/recordings/rec-login", "Forged"));
  expectUntouched(entries);
});

test("the dashboard refuses to render inside a foreign ancestor", () => {
  const root = document.createElement("div");
  const page = framedPage({
    location: { ancestorOrigins: [location.origin, "https://evil.example"] },
  });
  startDashboard(root, dashboardData(), page);
  expect(root.querySelector('[role="alert"]')?.textContent).toBe(
    "RECnRun does not run inside https://evil.example.",
  );
});

test("the dashboard framed by an allowed site publishes its route to the site", async () => {
  const root = document.createElement("div");
  const page = framedPage({ location: { ancestorOrigins: [location.origin], search: "" } });
  const posted = messagesTo(window);
  startDashboard(root, dashboardData(), page);
  await expect.poll(() => root.querySelectorAll("article")).toHaveLength(2);
  await expect.poll(() => posted).toContainEqual(locationMessage("/", "RECnRun"));
});

test("the content script frames the dashboard and syncs the route both ways", async () => {
  history.replaceState(null, "", "/recordings/rec-login?view=events");
  const frame = mountedFrame();
  expect(document.querySelector("iframe")?.src).toBe(
    `about:blank?route=${encodeURIComponent("/recordings/rec-login?view=events")}`,
  );

  postFromFrame(frame, navigateMessage("/recordings/rec-checkout"));
  postFromFrame(frame, locationMessage("/recordings/rec-checkout", "Checkout"));
  await expect.poll(() => document.title).toBe("Checkout");
  expect(location.pathname).toBe("/recordings/rec-checkout");

  const routes = messagesTo(frame);
  history.back();
  await expect.poll(() => routes).toContainEqual(routeMessage("/recordings/rec-login?view=events"));
});

test("a location the address bar has moved past adds no history entry and no title", async () => {
  history.replaceState(null, "", "/recordings/rec-login");
  const frame = mountedFrame();
  const entries = history.length;
  const title = document.title;

  // The frame's answer to an earlier Back, arriving after the next one.
  postFromFrame(frame, locationMessage("/", "Stale"));
  postFromFrame(frame, locationMessage("/recordings/rec-login", "Log in"));
  await expect.poll(() => document.title).not.toBe(title);
  expect(document.title).toBe("Log in");
  expect(location.pathname).toBe("/recordings/rec-login");
  expect(history.length).toBe(entries);
});

test("the content script listens to the frame channel once for the dashboard and the panel", () => {
  const page = Object.assign(new EventTarget(), {
    document,
    history,
    location,
    documentPictureInPicture: undefined,
  }) as unknown as Window;
  const added = vi.spyOn(page, "addEventListener");
  const frame = mountDashboardFrame("about:blank", location.origin, page);
  servePanelRequests(frame, "about:blank", location.origin, page);
  expect(added.mock.calls.filter(([type]) => type === "message")).toHaveLength(1);
});

test("in an incognito tab, the site is covered by where to record from instead of the frame", () => {
  showNotice(INCOGNITO_NOTICE);
  const notice = document.querySelector<HTMLElement>('[role="status"]');
  expect(notice?.textContent).toContain("Open recnrun.com there to record incognito tabs.");
  expect(notice?.style.position).toBe("fixed");
  expect(document.querySelector("iframe")).toBeNull();
});

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

/** The site page, with its reloads counted instead of made. */
function watchedFrame(connect: () => SitePort) {
  const frame = document.body.appendChild(document.createElement("iframe"));
  let connected = 0;
  let reloads = 0;
  const page = Object.assign(new EventTarget(), {
    document,
    location: { reload: () => (reloads += 1) },
  }) as unknown as Window;
  watchForOrphaning(
    frame,
    () => {
      connected += 1;
      return connect();
    },
    page,
  );
  return { frame, page, connections: () => connected, reloads: () => reloads };
}

test("once its frame loads, the site holds a port, and asks for a reload when it drops", async () => {
  const { port, disconnect } = fakePort();
  const { frame, connections } = watchedFrame(() => port);
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
  const { frame } = watchedFrame(() => {
    throw new Error("Extension context invalidated.");
  });
  frame.dispatchEvent(new Event("load"));
  expect(orphanNotice()).toBeDefined();
  expect(document.querySelector("iframe")).toBeNull();
});

test("an orphaned site reloads once the user comes back to it, as from chrome://extensions", () => {
  const { port, disconnect } = fakePort();
  const { frame, page, reloads } = watchedFrame(() => port);
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
