import { afterEach, expect, test, vi } from "vite-plus/test";
import type { SessionWindow } from "@/background/workspace/capture-api";
import { findSessionTabs, readLayout } from "@/background/workspace/session-tabs";
import { echoProbes, fakeEvent, fakePort } from "./fake-port";

const APP = "http://app.localhost:5192";
const OTHER = "http://other.localhost:5192";
const OPERATION = { id: "op-1", generation: 4 };
const BOUND = 5_000;

type Frame = { url: string; documentId: string } | null;

/**
 * Chrome as a capture sees the session: `windows`, each tab's top document, and an agent per
 * tab that answers a session read with `held[tabId]`, or not at all when it holds nothing listed.
 */
function sessionChrome(
  windows: SessionWindow[],
  frames: Record<number, Frame>,
  held: Record<number, Record<string, string>> = {},
) {
  const onConnect = fakeEvent<[ReturnType<typeof fakePort>]>();
  const inject = vi.fn(async (tabId: number, documentId: string) => {
    const origin = new URL(frames[tabId]?.url ?? "").origin;
    const agent = echoProbes(fakePort({ tab: { id: tabId }, frameId: 0, documentId, origin }));
    const post = agent.postMessage;
    agent.postMessage = (message: unknown) => {
      post(message);
      const { operationId, generation } = message as Record<string, unknown>;
      const entries = held[tabId];
      if (entries === undefined) return;
      const tag = { operationId, generation };
      const counts = { localStorage: 0, sessionStorage: Object.keys(entries).length };
      const empty = { databases: 0, records: 0, caches: 0, cacheEntries: 0 };
      queueMicrotask(() => {
        agent.onMessage.emit({
          type: "capture-storage",
          ...tag,
          localStorage: {},
          sessionStorage: entries,
        });
        agent.onMessage.emit({
          type: "captured",
          ...tag,
          counts: { ...counts, ...empty },
          cookieNames: [],
        });
      });
    };
    onConnect.emit(agent);
  });
  return {
    windows: vi.fn(async () => windows),
    topFrame: vi.fn(async (tabId: number) => frames[tabId] ?? null),
    inject,
    onConnect,
  };
}

const page = (url: string, documentId: string) => ({ url, documentId });

afterEach(() => {
  vi.useRealTimers();
});

const TWO_WINDOWS: SessionWindow[] = [
  {
    id: 1,
    focused: false,
    tabs: [
      { id: 10, active: false },
      { id: 11, active: true },
      { id: 12, active: false },
    ],
  },
  { id: 2, focused: true, tabs: [{ id: 20, active: true }] },
  { id: 3, focused: false, tabs: [{ id: 30, active: true }] },
];
const FRAMES: Record<number, Frame> = {
  10: page(`${APP}/app/`, "doc-10"),
  11: page(`${APP}/app/?tab=2`, "doc-11"),
  12: page("chrome://newtab/", "doc-12"),
  20: page(`${OTHER}/blank?tab=3`, "doc-20"),
  30: null,
};

test("finds each web, blank, and New Tab page in order and names the others by place and scheme", async () => {
  const found = await findSessionTabs(sessionChrome(TWO_WINDOWS, FRAMES), 10);
  expect(
    found.windows.map(({ focused, tabs }) => [focused, tabs.map(({ tabId }) => tabId)]),
  ).toEqual([
    [false, [10, 11, 12]],
    [true, [20]],
  ]);
  expect(found.primary).toMatchObject({ tabId: 10, windowId: 1, origin: APP, url: `${APP}/app/` });
  // Every tab counts as seen, a page RECnRun does not reopen too, so the close can tell a new one.
  expect(found.seen).toEqual([10, 11, 12, 20, 30]);
  expect(found.unsupported).toEqual([
    { adapter: "tabs", item: "window 3, tab 1", reason: "RECnRun could not read the tab's page." },
  ]);
});

test("names a tab of another scheme by its scheme only, never its address", async () => {
  const windows: SessionWindow[] = [
    {
      id: 1,
      focused: true,
      tabs: [10, 11, 12, 13].map((id) => ({ id, active: id === 10 })),
    },
    { id: 2, focused: false, tabs: [{ id: 14, active: true }] },
  ];
  const frames: Record<number, Frame> = {
    10: page(`${APP}/app/`, "doc-10"),
    11: page("about:blank", "doc-11"),
    12: page("chrome://settings/?secret=1", "doc-12"),
    13: page("chrome://newtab/", "doc-13"),
    14: page("file:///home/secret.html", "doc-14"),
  };
  const found = await findSessionTabs(sessionChrome(windows, frames), 10);
  expect(found.windows.map(({ tabs }) => tabs.map(({ url }) => url))).toEqual([
    [`${APP}/app/`, "about:blank", "chrome://newtab/"],
  ]);
  const reopens = "RECnRun reopens web pages, blank tabs, and New Tab pages";
  expect(found.unsupported).toEqual([
    { adapter: "tabs", item: "window 1, tab 3", reason: `${reopens}, not chrome: pages.` },
    { adapter: "tabs", item: "window 2, tab 1", reason: `${reopens}, not file: pages.` },
  ]);
  expect(JSON.stringify(found.unsupported)).not.toContain("secret");
});

test("reads the managed tab in full while it is open, else the focused window's active tab, else the first", async () => {
  const api = sessionChrome(TWO_WINDOWS, FRAMES);
  expect((await findSessionTabs(api, 11)).primary.tabId).toBe(11);
  expect((await findSessionTabs(api, 99)).primary.tabId).toBe(20);
  const unfocused = TWO_WINDOWS.map((window) => ({ ...window, focused: false }));
  expect((await findSessionTabs(sessionChrome(unfocused, FRAMES), 99)).primary.tabId).toBe(10);
  await expect(
    findSessionTabs(sessionChrome([TWO_WINDOWS[2] as SessionWindow], FRAMES), 30),
  ).rejects.toMatchObject({
    name: "TargetNotAllowed",
    message: "Only http and https pages can be captured.",
  });
});

test("marks the Incognito window focused last when Chrome reports none focused, else Chrome's", async () => {
  const unfocused = TWO_WINDOWS.map((window) => ({ ...window, focused: false }));
  const last = await findSessionTabs(sessionChrome(unfocused, FRAMES), 10, 2);
  expect(last.windows.map(({ focused }) => focused)).toEqual([false, true]);
  // The window Chrome reports focused now wins over the one noted before.
  const now = await findSessionTabs(sessionChrome(TWO_WINDOWS, FRAMES), 10, 1);
  expect(now.windows.map(({ focused }) => focused)).toEqual([false, true]);
  // A window noted but closed since leaves the layout unfocused, as before.
  const gone = await findSessionTabs(sessionChrome(unfocused, FRAMES), 10, 9);
  expect(gone.windows.map(({ focused }) => focused)).toEqual([false, false]);
});

test("lays out every web tab, each other tab with its own sessionStorage, the primary one without", async () => {
  const api = sessionChrome(TWO_WINDOWS, FRAMES, { 11: { tab: "second" }, 20: {} });
  const found = await findSessionTabs(api, 10);
  const read = await readLayout(found, { api, operation: OPERATION, boundMs: BOUND });
  expect(read.layout).toEqual({
    windows: [
      {
        focused: false,
        tabs: [
          { url: `${APP}/app/`, active: false, sessionStorage: [] },
          {
            url: `${APP}/app/?tab=2`,
            active: true,
            sessionStorage: [{ origin: APP, entries: { tab: "second" } }],
          },
          // A New Tab page reopens as one, with nothing read from it.
          { url: "chrome://newtab/", active: false, sessionStorage: [] },
        ],
      },
      {
        focused: true,
        tabs: [
          {
            url: `${OTHER}/blank?tab=3`,
            active: true,
            sessionStorage: [{ origin: OTHER, entries: {} }],
          },
        ],
      },
    ],
    primary: { window: 0, tab: 0 },
  });
  expect(read.entries).toBe(1);
  expect(read.unsupported).toEqual([]);
  expect(api.inject.mock.calls).toEqual([
    [11, "doc-11"],
    [20, "doc-20"],
  ]);
});

test("a tab whose page does not hand its sessionStorage over reopens without it, and is named", async () => {
  vi.useFakeTimers();
  const api = sessionChrome(TWO_WINDOWS, FRAMES, { 11: { tab: "second" } });
  const found = await findSessionTabs(api, 20);
  const reading = readLayout(found, { api, operation: OPERATION, boundMs: BOUND });
  await vi.advanceTimersByTimeAsync(BOUND);
  const read = await reading;
  expect(read.layout.primary).toEqual({ window: 1, tab: 0 });
  expect(read.layout.windows[0]?.tabs.map(({ sessionStorage }) => sessionStorage)).toEqual([
    [],
    [{ origin: APP, entries: { tab: "second" } }],
    [],
  ]);
  expect(read.unsupported).toEqual([
    { adapter: "tabs", item: "window 1, tab 1", reason: "The page stopped sending its data." },
  ]);
});

const UNLOADED: SessionWindow[] = [
  {
    id: 1,
    focused: true,
    tabs: [
      { id: 10, active: true, discarded: true, url: `${APP}/app/` },
      { id: 11, active: false, discarded: true, url: "about:blank" },
      { id: 12, active: false, discarded: true },
      { id: 13, active: false, discarded: true, url: "chrome://settings/" },
      { id: 14, active: false },
    ],
  },
];

test("keeps a tab Chrome unloaded by the address it shows, without reading its page", async () => {
  const api = sessionChrome(UNLOADED, { 14: page(`${OTHER}/blank`, "doc-14") });
  const found = await findSessionTabs(api, 10);
  expect(found.windows[0]?.tabs).toEqual([
    {
      tabId: 10,
      windowId: 1,
      active: true,
      url: `${APP}/app/`,
      origin: APP,
      place: "window 1, tab 1",
    },
    { tabId: 11, windowId: 1, active: false, url: "about:blank", place: "window 1, tab 2" },
    expect.objectContaining({ tabId: 14, documentId: "doc-14" }),
  ]);
  expect(found.unsupported.map(({ item }) => item)).toEqual(["window 1, tab 3", "window 1, tab 4"]);
  expect(api.topFrame.mock.calls).toEqual([[14]]);
  // A loaded web tab is read in full over the managed one Chrome unloaded.
  expect(found.primary.tabId).toBe(14);
  const read = await readLayout(found, { api, operation: OPERATION, boundMs: BOUND });
  expect(read.layout.primary).toEqual({ window: 0, tab: 2 });
  // An unloaded tab's own sessionStorage comes with its other origins, never through an agent.
  expect(api.inject).not.toHaveBeenCalled();
});

test("reads a tab Chrome unloaded in full when no web tab of the session runs a page", async () => {
  const windows = [
    { ...UNLOADED[0], tabs: UNLOADED[0]?.tabs.slice(0, 2) ?? [] },
  ] as SessionWindow[];
  const found = await findSessionTabs(sessionChrome(windows, {}), 99);
  expect(found.primary).toEqual({
    tabId: 10,
    windowId: 1,
    active: true,
    url: `${APP}/app/`,
    origin: APP,
    place: "window 1, tab 1",
  });
});
