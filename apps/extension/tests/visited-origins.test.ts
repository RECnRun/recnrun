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

/** The tracker over fakes: tabs 9 and 10 are Incognito ones, tab 1 a normal one. */
function tracked(managed: ManagedWindowState | null = MANAGED) {
  const onCommitted = fakeEvent<[{ tabId: number; frameId: number; url: string }]>();
  const visits = memoryVisits();
  const state = { managed };
  trackVisitedOrigins({
    onCommitted,
    incognitoTab: async (tabId) => tabId === 9 || tabId === 10,
    managed: async () => state.managed,
    visits,
  });
  const commit = (tabId: number, url: string, frameId = 0) =>
    onCommitted.emit({ tabId, frameId, url });
  return { visits, state, commit };
}

test("notes each top document's origin in any Incognito tab while the managed window is open", async () => {
  const { visits, commit } = tracked();
  commit(9, `${APP}/app/?run=1`);
  // A popup or second tab shares the identity's Incognito profile, so its origin counts too.
  commit(10, `${SSO}/authorize?client=app`);
  commit(9, `${APP}/other`);
  await vi.waitFor(() => expect(visits.list).toEqual({ generation: 3, origins: [APP, SSO] }));
});

test("leaves out frames, normal tabs, pages off the web, and a closed managed window", async () => {
  const { visits, state, commit } = tracked();
  commit(9, `${SSO}/frame`, 4);
  commit(1, `${SSO}/`);
  for (const url of ["about:blank", "chrome://newtab/", "data:text/html,x"]) commit(9, url);
  state.managed = { ...MANAGED, status: "closed" };
  commit(9, `${SSO}/`);
  state.managed = null;
  commit(9, `${SSO}/`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(visits.note).not.toHaveBeenCalled();
});

test("keeps each origin once per generation, in order, and starts again with a new one", async () => {
  expect(await visitedOrigins.visited(3)).toEqual([]);
  await visitedOrigins.note(3, [APP, APP]);
  await visitedOrigins.note(3, [SSO, APP]);
  expect(await visitedOrigins.visited(3)).toEqual([APP, SSO]);
  expect(await visitedOrigins.visited(4)).toEqual([]);
  expect(await fakeBrowser.storage.session.get(KEY)).toEqual({
    [KEY]: { generation: 3, origins: [APP, SSO] },
  });
  await visitedOrigins.note(4, [SSO]);
  expect(await visitedOrigins.visited(3)).toEqual([]);
  expect(await visitedOrigins.visited(4)).toEqual([SSO]);
  // A new generation is stored even when it starts with nothing.
  await visitedOrigins.note(5, []);
  expect(await fakeBrowser.storage.session.get(KEY)).toEqual({
    [KEY]: { generation: 5, origins: [] },
  });
});

test("two notes at once keep both origins", async () => {
  await Promise.all([visitedOrigins.note(1, [APP]), visitedOrigins.note(1, [SSO])]);
  expect(await visitedOrigins.visited(1)).toEqual([APP, SSO]);
});

test("refuses a stored list that does not match the schema, such as a page off the web", async () => {
  await fakeBrowser.storage.session.set({
    [KEY]: { generation: 1, origins: ["chrome://settings"] },
  });
  await expect(visitedOrigins.visited(1)).rejects.toThrow(
    "The stored visited origins do not match the current schema.",
  );
  await expect(visitedOrigins.note(1, [APP])).rejects.toThrow("current schema");
  await fakeBrowser.storage.session.remove(KEY);
  await visitedOrigins.note(1, [APP]);
  expect(await visitedOrigins.visited(1)).toEqual([APP]);
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
  await vi.waitFor(async () => expect(await visitedOrigins.visited(3)).toEqual([APP]));
  expect(get).toHaveBeenCalledWith(2);
});
