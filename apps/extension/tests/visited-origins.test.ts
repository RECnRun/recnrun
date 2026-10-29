import type { ManagedWindowState } from "@recnrun/domain";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { trackVisitedOrigins } from "@/background/workspace/visited-origins";
import { managedWindowRepository } from "@/storage/managed-window-repository";
import { visitedOrigins } from "@/storage/visited-origins";
import { memoryVisits } from "./fake-helper";
import { fakeEvent } from "./fake-port";

const KEY = "visited-origins";
const APP = "http://app.localhost:5192";
const SSO = "http://sso.localhost:5192";
const MANAGED: ManagedWindowState = { generation: 3, windowId: 5, tabId: 9, status: "active" };

beforeEach(() => {
  fakeBrowser.reset();
});

/** The tracker over fakes: tabs 9 and 10 are Incognito ones, tab 11 a helper, tab 1 a normal one. */
function tracked(managed: ManagedWindowState | null = MANAGED) {
  const onCommitted = fakeEvent<[{ tabId: number; frameId: number; url: string }]>();
  const visits = memoryVisits();
  const state = { managed };
  trackVisitedOrigins({
    onCommitted,
    incognitoTab: async (tabId) => [9, 10, 11].includes(tabId),
    helperTab: (tabId) => tabId === 11,
    managed: async () => state.managed,
    visits,
  });
  const commit = (tabId: number, url: string, frameId = 0) =>
    onCommitted.emit({ tabId, frameId, url });
  return { visits, state, commit };
}

test("notes each top document's origin and page in any Incognito tab while the window is open", async () => {
  const { visits, commit } = tracked();
  commit(9, `${APP}/app/?run=1`);
  // A popup or second tab shares the identity's Incognito profile, so its origin counts too.
  commit(10, `${SSO}/authorize?client=app#state`);
  commit(9, `${APP}/other`);
  // The query and fragment can carry tokens, so only the path is kept.
  await vi.waitFor(() =>
    expect(visits.list).toEqual({
      generation: 3,
      visits: [
        { origin: APP, url: `${APP}/other` },
        { origin: SSO, url: `${SSO}/authorize` },
      ],
    }),
  );
  // Each tab keeps its own list, since its sessionStorage on each origin is its own.
  await vi.waitFor(() =>
    expect(visits.tabs.tabs).toEqual([
      { tabId: 10, visits: [{ origin: SSO, url: `${SSO}/authorize` }] },
      { tabId: 9, visits: [{ origin: APP, url: `${APP}/other` }] },
    ]),
  );
});

test("leaves out frames, normal and helper tabs, pages off the web, and a closed window", async () => {
  const { visits, state, commit } = tracked();
  commit(9, `${SSO}/frame`, 4);
  commit(1, `${SSO}/`);
  commit(11, `${SSO}/`);
  for (const url of ["about:blank", "chrome://newtab/", "data:text/html,x"]) commit(9, url);
  state.managed = { ...MANAGED, status: "closed" };
  commit(9, `${SSO}/`);
  state.managed = null;
  commit(9, `${SSO}/`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(visits.note).not.toHaveBeenCalled();
});

const at = (origin: string, path = "/") => ({ origin, url: `${origin}${path}` });

test("keeps each origin once per generation, in order, and starts again with a new one", async () => {
  expect(await visitedOrigins.visited(3)).toEqual([]);
  await visitedOrigins.note(3, [at(APP), at(APP, "/a")]);
  await visitedOrigins.note(3, [{ origin: SSO }, { origin: APP }]);
  // A visit without a page keeps the last one.
  expect(await visitedOrigins.visited(3)).toEqual([at(APP, "/a"), { origin: SSO }]);
  expect(await visitedOrigins.visited(4)).toEqual([]);
  expect(await fakeBrowser.storage.session.get(KEY)).toEqual({
    [KEY]: { generation: 3, visits: [at(APP, "/a"), { origin: SSO }], tabs: [] },
  });
  await visitedOrigins.note(4, [at(SSO)]);
  expect(await visitedOrigins.visited(3)).toEqual([]);
  expect(await visitedOrigins.visited(4)).toEqual([at(SSO)]);
  // A new generation is stored even when it starts with nothing.
  await visitedOrigins.note(5, []);
  expect(await fakeBrowser.storage.session.get(KEY)).toEqual({
    [KEY]: { generation: 5, visits: [], tabs: [] },
  });
});

test("an origin a start could not restore carries until the identity's own tab loads it", async () => {
  await visitedOrigins.note(1, [{ origin: APP }, { origin: SSO }]);
  await visitedOrigins.note(1, [{ origin: SSO, carry: true }]);
  expect(await visitedOrigins.visited(1)).toEqual([{ origin: APP }, { origin: SSO, carry: true }]);
  await visitedOrigins.note(1, [at(SSO, "/home")]);
  expect(await visitedOrigins.visited(1)).toEqual([{ origin: APP }, at(SSO, "/home")]);
});

test("keeps each tab's visits apart, with the place a start reopened it from", async () => {
  expect(await visitedOrigins.tabVisits(2)).toEqual([]);
  await visitedOrigins.noteTab(2, 9, [at(APP)], { window: 0, tab: 1 });
  await visitedOrigins.noteTab(2, 10, [at(SSO)]);
  await visitedOrigins.noteTab(2, 9, [{ origin: SSO, carry: true }, at(APP, "/a")]);
  expect(await visitedOrigins.tabVisits(2)).toEqual([
    { tabId: 10, visits: [at(SSO)] },
    {
      tabId: 9,
      from: { window: 0, tab: 1 },
      visits: [at(APP, "/a"), { origin: SSO, carry: true }],
    },
  ]);
  // The lists belong to their generation, as the session list does.
  expect(await visitedOrigins.tabVisits(3)).toEqual([]);
  await visitedOrigins.note(3, []);
  expect(await visitedOrigins.tabVisits(2)).toEqual([]);
});

test("two notes at once keep both origins", async () => {
  await Promise.all([visitedOrigins.note(1, [at(APP)]), visitedOrigins.note(1, [at(SSO)])]);
  expect(await visitedOrigins.visited(1)).toEqual([at(APP), at(SSO)]);
});

test("refuses a stored list that does not match the schema, such as a page off its origin", async () => {
  for (const visits of [[{ origin: "chrome://settings" }], [{ origin: APP, url: `${SSO}/` }]]) {
    await fakeBrowser.storage.session.set({ [KEY]: { generation: 1, visits } });
    await expect(visitedOrigins.visited(1)).rejects.toThrow(
      "The stored visited origins do not match the current schema.",
    );
  }
  await expect(visitedOrigins.note(1, [at(APP)])).rejects.toThrow("current schema");
  await fakeBrowser.storage.session.remove(KEY);
  await visitedOrigins.note(1, [at(APP)]);
  expect(await visitedOrigins.visited(1)).toEqual([at(APP)]);
});

test("Chrome's tracking reads the managed window and the tab's Incognito flag", async () => {
  await managedWindowRepository.update(() => MANAGED);
  const get = vi.spyOn(fakeBrowser.tabs, "get");
  get.mockImplementation((async (tabId: number) => {
    if (tabId === 9) return { id: 9, incognito: true };
    throw new Error("No tab with id.");
  }) as never);
  trackVisitedOrigins();
  await fakeBrowser.webNavigation.onCommitted.trigger({
    tabId: 2,
    frameId: 0,
    url: `${SSO}/`,
  } as never);
  await fakeBrowser.webNavigation.onCommitted.trigger({
    tabId: 9,
    frameId: 0,
    url: `${APP}/`,
  } as never);
  await vi.waitFor(async () => expect(await visitedOrigins.visited(3)).toEqual([at(APP)]));
  expect(get).toHaveBeenCalledWith(2);
});
