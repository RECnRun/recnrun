import type { BrowserContext, Worker } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, launchWithExtension, test } from "./fixtures/extension.ts";
import { dashboardUrl } from "./fixtures/tabs.ts";

const PRIVACY = "http://localhost:5190/privacy/";

interface ChromeTab {
  id: number;
  url?: string;
  index: number;
  active: boolean;
  windowId: number;
}

interface ChromeGlobal {
  chrome: {
    tabs: {
      query(info: object): Promise<ChromeTab[]>;
      move(id: number, properties: object): Promise<void>;
    };
    windows: {
      create(data: object): Promise<{ id: number }>;
      getAll(info: object): Promise<{ id: number }[]>;
      remove(id: number): Promise<void>;
    };
  };
}

/** Each window's tabs by address, in order, with the active one marked by a leading `*`. */
function layout(serviceWorker: Worker) {
  return serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    const windows: Record<number, string[]> = {};
    for (const tab of tabs.toSorted((a, b) => a.index - b.index))
      (windows[tab.windowId] ??= []).push(`${tab.active ? "*" : ""}${tab.url ?? ""}`);
    return Object.values(windows);
  });
}

/** A normal window on the privacy policy, as the user would open one. */
const openWindow = (serviceWorker: Worker) =>
  serviceWorker.evaluate(
    (url) => (globalThis as unknown as ChromeGlobal).chrome.windows.create({ url }),
    PRIVACY,
  );

async function workerOf(context: BrowserContext): Promise<Worker> {
  const [running] = context.serviceWorkers();
  return running ?? (await context.waitForEvent("serviceworker"));
}

test("once installed, the dashboard is the first tab of the window, and in focus", async ({
  serviceWorker,
}) => {
  await expect
    .poll(() => layout(serviceWorker))
    .toEqual([[`*${dashboardUrl(serviceWorker)}`, "about:blank"]]);
});

test("a profile reopened with its tabs restored keeps one dashboard, first and in focus", async ({
  headless,
}) => {
  const profile = mkdtempSync(join(tmpdir(), "recnrun-restart-"));
  const first = await launchWithExtension(profile, headless);
  const worker = await workerOf(first);
  const site = await first.newPage();
  await site.goto("/privacy/");
  // The user moves the dashboard away from the front before quitting.
  await worker.evaluate(async (url) => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const [dashboard] = await chrome.tabs.query({ url });
    if (dashboard) await chrome.tabs.move(dashboard.id, { index: -1 });
  }, dashboardUrl(worker));
  await first.close();
  const preferences = join(profile, "Default", "Preferences");
  const settings = JSON.parse(readFileSync(preferences, "utf8"));
  writeFileSync(preferences, JSON.stringify({ ...settings, session: { restore_on_startup: 1 } }));

  const second = await launchWithExtension(profile, headless);
  const restarted = await workerOf(second);
  const dashboard = dashboardUrl(restarted);
  await expect
    .poll(async () => (await layout(restarted)).flat().filter((url) => url.endsWith(dashboard)))
    .toEqual([`*${dashboard}`]);
  const [window] = await layout(restarted);
  expect(window?.[0]).toBe(`*${dashboard}`);
  expect(window).toContain(PRIVACY);
  await second.close();
  rmSync(profile, { recursive: true, force: true });
});

test("the first normal window after every other closed gets the dashboard; another does not", async ({
  serviceWorker,
}) => {
  const dashboard = dashboardUrl(serviceWorker);
  await expect.poll(async () => (await layout(serviceWorker)).flat()).toContain(`*${dashboard}`);
  // A popup keeps the browser running once every normal window is gone.
  await serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    await chrome.windows.create({ type: "popup", url: "about:blank" });
    for (const { id } of await chrome.windows.getAll({ windowTypes: ["normal"] }))
      await chrome.windows.remove(id);
  });
  await expect.poll(() => layout(serviceWorker)).toEqual([]);

  await openWindow(serviceWorker);
  await expect.poll(() => layout(serviceWorker)).toEqual([[`*${dashboard}`, PRIVACY]]);

  await openWindow(serviceWorker);
  await expect.poll(async () => (await layout(serviceWorker)).length).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect((await layout(serviceWorker))[1]).toEqual([`*${PRIVACY}`]);
});
