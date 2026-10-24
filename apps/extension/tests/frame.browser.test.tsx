import { afterEach, expect, test } from "vite-plus/test";
import { mountDashboardFrame } from "@/content/dashboard-frame";
import { INCOGNITO_NOTICE, ORPHANED_NOTICE, showNotice } from "@/content/notice";
import { watchForOrphaning } from "@/content/orphan-watch";
import type { SitePort } from "@/messaging/site-port";
import { createFrameRouter } from "@/dashboard/router";
import { startDashboard } from "@/dashboard/start";
import { locationMessage, routeMessage } from "@/messaging/frame-protocol";
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
  router.publish("/", "RECnRun");
  await expect.poll(() => posted).toContainEqual(locationMessage("/", "RECnRun"));
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
  mountDashboardFrame("about:blank", location.origin);
  const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="RECnRun dashboard"]');
  expect(iframe?.src).toBe(
    `about:blank?route=${encodeURIComponent("/recordings/rec-login?view=events")}`,
  );
  const frame = iframe?.contentWindow;
  if (!frame) throw new Error("The dashboard frame did not load.");

  // The frame's own script must post, so the message's source is the frame.
  const script = frame.document.createElement("script");
  script.textContent = `parent.postMessage(${JSON.stringify(locationMessage("/recordings/rec-checkout", "Checkout"))}, "*")`;
  frame.document.body.append(script);
  await expect.poll(() => location.pathname).toBe("/recordings/rec-checkout");
  expect(document.title).toBe("Checkout");

  const routes = messagesTo(frame);
  history.back();
  await expect.poll(() => routes).toContainEqual(routeMessage("/recordings/rec-login?view=events"));
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

function watchedFrame(connect: () => SitePort) {
  const frame = document.body.appendChild(document.createElement("iframe"));
  let connected = 0;
  watchForOrphaning(frame, () => {
    connected += 1;
    return connect();
  });
  return { frame, connections: () => connected };
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
