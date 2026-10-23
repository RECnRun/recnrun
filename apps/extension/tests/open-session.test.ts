import type { RecordingSession } from "@recnrun/domain";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  endSessionOf,
  floatSessionOn,
  nextSession,
  openSessionFrom,
} from "@/background/open-session";
import type { SessionStore } from "@/background/open-session";

const SESSION = "chrome-extension://test-id/session.html";
const NOW = 50_000;

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function memoryStore(initial: RecordingSession | null = null): SessionStore & {
  current: () => RecordingSession | null;
} {
  let session = initial;
  return {
    read: async () => session,
    write: async (next) => {
      session = next;
    },
    current: () => session,
  };
}

function tab(properties: Partial<Browser.tabs.Tab>): Browser.tabs.Tab {
  return {
    id: 7,
    index: 2,
    windowId: 1,
    url: "https://shop.example/cart",
    pinned: false,
    highlighted: true,
    active: true,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    frozen: false,
    lastAccessed: 0,
    splitViewId: -1,
    ...properties,
  };
}

/** fakeBrowser has no Split View or tab moves, so these stand in for Chrome's. */
function fakeTabMoves() {
  const unsplit = vi.fn(async (_splitViewId: number) => {});
  const createSplit = vi.fn(async (_tabIds: [number, number]) => 9);
  const move = vi.fn(async (_tabId: number, _properties: object) => ({}));
  Object.assign(fakeBrowser.tabs, { unsplit, createSplit, move });
  return { unsplit, createSplit, move };
}

/** The session's pane as Chrome reports it; fakeBrowser keeps whatever an update passes. */
async function openPane(properties: Partial<Browser.tabs.Tab>) {
  const { id = -1 } = await fakeBrowser.tabs.create({ url: SESSION });
  await fakeBrowser.tabs.update(id, properties as Browser.tabs.UpdateProperties);
  return id;
}

const recording = (tabId: number): RecordingSession => ({
  tabId,
  status: "recording",
  banked: 0,
  since: NOW,
});

test("a trigger starts recording its tab, or moves the session in progress there", () => {
  expect(nextSession(null, 7, NOW)).toEqual(recording(7));
  const paused = { tabId: 3, status: "paused" as const, banked: 4_000, since: 9_000 };
  expect(nextSession(paused, 7, NOW)).toEqual({ ...paused, tabId: 7 });
});

test("records the tab and opens the session's pane beside it in a Split View", async () => {
  const store = memoryStore();
  const create = vi.spyOn(fakeBrowser.tabs, "create");
  await openSessionFrom(tab({}), SESSION, store, { split: true, now: NOW });
  expect(store.current()).toEqual(recording(7));
  expect(create).toHaveBeenCalledWith({ url: SESSION, splitWithTabId: 7, windowId: 1, index: 3 });
});

test("opens the pane as a tab next to the page without Split View, or when Chrome refuses it", async () => {
  const create = vi.spyOn(fakeBrowser.tabs, "create");
  await openSessionFrom(tab({}), SESSION, memoryStore(), { split: false, now: NOW });
  expect(create).toHaveBeenLastCalledWith({ url: SESSION, windowId: 1, index: 3 });

  create.mockRejectedValueOnce(new Error("Split View is off"));
  await openSessionFrom(tab({ id: 8 }), SESSION, memoryStore(), { split: true, now: NOW });
  expect(create).toHaveBeenLastCalledWith({ url: SESSION, windowId: 1, index: 3 });
});

test("replaces a stored session that no longer matches the schema", async () => {
  const store = memoryStore();
  store.read = () => Promise.reject(new Error("The stored recording does not match"));
  await openSessionFrom(tab({}), SESSION, store, { split: false, now: NOW });
  expect(store.current()).toEqual(recording(7));
});

test("a page split with another tab leaves that split for the pane", async () => {
  const { unsplit } = fakeTabMoves();
  const create = vi.spyOn(fakeBrowser.tabs, "create");
  await openSessionFrom(tab({ splitViewId: 4 }), SESSION, memoryStore(), { split: true, now: NOW });
  expect(unsplit).toHaveBeenCalledWith(4);
  expect(create).toHaveBeenCalledWith({ url: SESSION, splitWithTabId: 7, windowId: 1, index: 3 });
});

test("focuses the pane already split with the page, keeping the session", async () => {
  const { unsplit } = fakeTabMoves();
  const pane = await openPane({ splitViewId: 4, active: false });
  const store = memoryStore({ ...recording(7), banked: 3_000 });
  const create = vi.spyOn(fakeBrowser.tabs, "create");

  await openSessionFrom(tab({ splitViewId: 4 }), SESSION, store, { split: true, now: NOW + 1 });
  expect(create).not.toHaveBeenCalled();
  expect(unsplit).not.toHaveBeenCalled();
  expect((await fakeBrowser.tabs.get(pane)).active).toBe(true);
  expect(store.current()).toEqual({ ...recording(7), banked: 3_000 });
});

test("moves the pane beside another page without reloading it, and records that page", async () => {
  const { unsplit, createSplit, move } = fakeTabMoves();
  const pane = await openPane({ index: 0, windowId: 1, splitViewId: 4 });
  const store = memoryStore(recording(7));
  const create = vi.spyOn(fakeBrowser.tabs, "create");

  await openSessionFrom(tab({ id: 30, index: 5 }), SESSION, store, { split: true, now: NOW });
  expect(create).not.toHaveBeenCalled();
  expect(unsplit).toHaveBeenCalledWith(4);
  expect(move).toHaveBeenCalledWith(pane, { windowId: 1, index: 5 });
  expect(createSplit).toHaveBeenCalledWith([30, pane]);
  expect((await fakeBrowser.tabs.get(pane)).active).toBe(true);
  expect(store.current()).toEqual(recording(30));
});

test("moves the pane from another window to the right of the page", async () => {
  const { unsplit, move } = fakeTabMoves();
  const pane = await openPane({ index: 0, windowId: 1, splitViewId: -1 });
  await openSessionFrom(tab({ id: 30, index: 0, windowId: 2 }), SESSION, memoryStore(), {
    split: true,
    now: NOW,
  });
  expect(unsplit).not.toHaveBeenCalled();
  expect(move).toHaveBeenCalledWith(pane, { windowId: 2, index: 1 });
});

test("still focuses the pane when Chrome refuses to move it", async () => {
  const { move } = fakeTabMoves();
  move.mockRejectedValue(new Error("Tabs cannot be edited right now"));
  const pane = await openPane({ index: 0, windowId: 1, splitViewId: -1 });
  const focusWindow = vi.spyOn(fakeBrowser.windows, "update");

  await openSessionFrom(tab({ id: 30 }), SESSION, memoryStore(), { split: true, now: NOW });
  expect((await fakeBrowser.tabs.get(pane)).active).toBe(true);
  expect(focusWindow).toHaveBeenCalledWith(1, { focused: true });
});

test("does nothing for the pane itself or without a tab", async () => {
  const store = memoryStore();
  const create = vi.spyOn(fakeBrowser.tabs, "create");
  await openSessionFrom(tab({ url: `${SESSION}` }), SESSION, store, { split: true, now: NOW });
  await openSessionFrom(undefined, SESSION, store, { split: true, now: NOW });
  expect(create).not.toHaveBeenCalled();
  expect(store.current()).toBeNull();
});

test("a session a dashboard floats records the tab and brings it to the front", async () => {
  const page = await fakeBrowser.tabs.create({ url: "https://shop.example/", active: false });
  const store = memoryStore();
  const focusWindow = vi.spyOn(fakeBrowser.windows, "update");

  await floatSessionOn(page.id ?? -1, store, NOW);
  expect(store.current()).toEqual(recording(page.id ?? -1));
  expect((await fakeBrowser.tabs.get(page.id ?? -1)).active).toBe(true);
  expect(focusWindow).toHaveBeenCalledWith(page.windowId, { focused: true });
});

test("closing the recorded tab ends the session; other tabs leave it alone", async () => {
  const store = memoryStore(recording(7));
  await endSessionOf(8, store);
  expect(store.current()).toEqual(recording(7));
  await endSessionOf(7, store);
  expect(store.current()).toBeNull();
});
