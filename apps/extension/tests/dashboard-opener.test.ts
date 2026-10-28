import { expect, test } from "vite-plus/test";
import { createDashboardOpener } from "@/background/dashboard-opener";
import type { BrowserWindow, DashboardBrowser, DashboardTab } from "@/background/dashboard-opener";

const DASHBOARD = "chrome-extension://id/dashboard.html";
const SITE = "https://shop.example/";

interface Seed {
  windows: { id: number; incognito?: boolean }[];
  /** Each window's tabs, by address, in order. */
  tabs: Record<number, string[]>;
  lastFocused?: number;
}

/** A browser of normal windows and their tabs, which the opener changes as Chrome would. */
function fakeBrowser(seed: Seed) {
  const windows: BrowserWindow[] = seed.windows.map((each) => ({ incognito: false, ...each }));
  let nextId = 100;
  const order = new Map(
    windows.map((each) => [
      each.id,
      (seed.tabs[each.id] ?? []).map((url) => ({ id: nextId++, url })),
    ]),
  );
  const incognito = (windowId: number) =>
    windows.find((each) => each.id === windowId)?.incognito ?? false;
  const all = (): DashboardTab[] =>
    [...order].flatMap(([windowId, list]) =>
      list.map((tab, index) => ({ ...tab, windowId, index, incognito: incognito(windowId) })),
    );
  const focused: number[] = [];
  const listOf = (windowId: number) => order.get(windowId) ?? [];
  const browser: DashboardBrowser = {
    tabs: async () => all(),
    windows: async () => windows.map((each) => ({ ...each })),
    lastFocused: async () => windows.find((each) => each.id === seed.lastFocused),
    async open(windowId, index) {
      const list = listOf(windowId);
      const tab = { id: nextId++, url: DASHBOARD };
      list.splice(index ?? list.length, 0, tab);
      return { ...tab, windowId, index: list.indexOf(tab), incognito: false };
    },
    async openWindow() {
      const id = Math.max(0, ...windows.map((each) => each.id)) + 1;
      windows.push({ id, incognito: false });
      order.set(id, [{ id: nextId, url: DASHBOARD }]);
      focused.push(nextId++);
    },
    async move(moved, index) {
      const list = listOf(moved.windowId);
      const [tab] = list.splice(
        list.findIndex((each) => each.id === moved.id),
        1,
      );
      if (tab) list.splice(index, 0, tab);
    },
    async focus(tab) {
      focused.push(tab.id);
    },
  };
  /** Each window's tabs, by address, in order. */
  const layout = () =>
    Object.fromEntries([...order].map(([id, list]) => [id, list.map((tab) => tab.url)]));
  const idOf = (windowId: number, index: number) => listOf(windowId)[index]?.id;
  const addWindow = (id: number) => {
    windows.push({ id, incognito: false });
    order.set(id, []);
  };
  return { browser, layout, focused, idOf, addWindow };
}

const opener = (fake: ReturnType<typeof fakeBrowser>) =>
  createDashboardOpener(fake.browser, DASHBOARD);

test("the toolbar icon focuses the first dashboard: lowest window, then lowest index", async () => {
  const fake = fakeBrowser({
    windows: [{ id: 2 }, { id: 1 }],
    tabs: { 1: [SITE, DASHBOARD, `${DASHBOARD}#/recordings/rec-login`], 2: [DASHBOARD] },
  });
  const first = fake.idOf(1, 1);
  await opener(fake).show({ windowId: 2, incognito: false });
  expect(fake.focused).toEqual([first]);
  expect(fake.layout()[1]).toHaveLength(3);
});

test("with no dashboard, the toolbar icon opens one in the clicked window", async () => {
  const fake = fakeBrowser({ windows: [{ id: 1 }, { id: 2 }], tabs: { 1: [SITE], 2: [SITE] } });
  await opener(fake).show({ windowId: 2, incognito: false });
  expect(fake.layout()).toEqual({ 1: [SITE], 2: [SITE, DASHBOARD] });
  expect(fake.focused).toEqual([fake.idOf(2, 1)]);
});

test("from an incognito window, the icon opens the dashboard in a normal one", async () => {
  const fake = fakeBrowser({
    windows: [{ id: 1 }, { id: 2, incognito: true }, { id: 3 }],
    tabs: { 1: [SITE], 2: [SITE], 3: [SITE] },
    lastFocused: 3,
  });
  await opener(fake).show({ windowId: 2, incognito: true });
  expect(fake.layout()).toEqual({ 1: [SITE], 2: [SITE], 3: [SITE, DASHBOARD] });

  const alone = fakeBrowser({
    windows: [{ id: 2, incognito: true }],
    tabs: { 2: [SITE] },
    lastFocused: 2,
  });
  await opener(alone).show({ windowId: 2, incognito: true });
  expect(alone.layout()).toEqual({ 2: [SITE], 3: [DASHBOARD] });
});

test("a dashboard that is still loading counts, so a second click opens no other", async () => {
  const fake = fakeBrowser({ windows: [{ id: 1 }], tabs: { 1: [SITE] } });
  const open = opener(fake);
  await Promise.all([
    open.show({ windowId: 1, incognito: false }),
    open.show({ windowId: 1, incognito: false }),
  ]);
  expect(fake.layout()).toEqual({ 1: [SITE, DASHBOARD] });
});

test("the profile starts with the dashboard first in the last focused window", async () => {
  // With no window focused yet, the lowest window id goes first.
  const fake = fakeBrowser({ windows: [{ id: 2 }, { id: 1 }], tabs: { 1: [SITE], 2: [SITE] } });
  await opener(fake).lead();
  expect(fake.layout()[2]).toEqual([SITE]);
  expect(fake.layout()[1]).toEqual([DASHBOARD, SITE]);

  const focusedLast = fakeBrowser({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: { 1: [SITE], 2: [SITE] },
    lastFocused: 2,
  });
  await opener(focusedLast).lead();
  expect(focusedLast.layout()).toEqual({ 1: [SITE], 2: [DASHBOARD, SITE] });
  expect(focusedLast.focused).toEqual([focusedLast.idOf(2, 0)]);
});

test("a dashboard Chrome restored moves to the front instead of opening another", async () => {
  const fake = fakeBrowser({ windows: [{ id: 1 }], tabs: { 1: [SITE, SITE, DASHBOARD] } });
  const restored = fake.idOf(1, 2);
  await opener(fake).lead();
  expect(fake.layout()).toEqual({ 1: [DASHBOARD, SITE, SITE] });
  expect(fake.focused).toEqual([restored]);
});

test("a profile with no window yet waits for the first one", async () => {
  const fake = fakeBrowser({ windows: [], tabs: {} });
  await opener(fake).lead();
  expect(fake.layout()).toEqual({});
  expect(fake.focused).toEqual([]);
});

test("the first normal window of the profile gets the dashboard; a second one does not", async () => {
  const fake = fakeBrowser({ windows: [{ id: 1 }], tabs: { 1: [SITE] } });
  const open = opener(fake);
  await open.windowOpened({ id: 1, type: "normal", incognito: false });
  expect(fake.layout()).toEqual({ 1: [DASHBOARD, SITE] });

  fake.addWindow(2);
  await open.windowOpened({ id: 2, type: "normal", incognito: false });
  await open.windowOpened({ id: 3, type: "popup", incognito: false });
  await open.windowOpened({ id: 4, type: "normal", incognito: true });
  expect(fake.layout()).toEqual({ 1: [DASHBOARD, SITE], 2: [] });
});

test("an incognito window open beside it does not keep the first normal one from it", async () => {
  const fake = fakeBrowser({
    windows: [{ id: 1, incognito: true }, { id: 2 }],
    tabs: { 1: [SITE], 2: [SITE] },
  });
  await opener(fake).windowOpened({ id: 2, type: "normal", incognito: false });
  expect(fake.layout()).toEqual({ 1: [SITE], 2: [DASHBOARD, SITE] });
});
