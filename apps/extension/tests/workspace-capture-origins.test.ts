import { approximateBytes } from "@recnrun/domain";
import type { IdentityCapture, ManagedWindowState, OriginCapture } from "@recnrun/domain";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { captureIdentity } from "@/background/workspace/capture";
import {
  COUNTS,
  DATABASE,
  LOCAL,
  RECORDS,
  SESSION,
  capturedWith,
  completeReplies,
} from "./capture-replies";
import { fakeBarrierApi } from "./fake-barrier";
import { chrome, memoryCaptures } from "./fake-capture";
import { fakeHelperTabs, helperNavigation, memoryVisits } from "./fake-helper";
import { fakeNavigationApi } from "./fake-navigation";
import type { TabVisits, Visit } from "@/ports/visited-origins";

const ORIGIN = "http://app.localhost:5192";
const SSO = "http://sso.localhost:5192";
const CDN = "http://cdn.localhost:5192";
const MANAGED: ManagedWindowState = { generation: 4, windowId: 9, tabId: 7, status: "active" };
const SSO_LOCAL = { idp_user: "A" };
const SSO_DATABASE = {
  name: "idp",
  version: 1,
  stores: [{ ...DATABASE.stores[0], name: "session" }],
};
const SSO_RECORDS = [{ key: "user", value: "A" }];
const SSO_COUNTS = {
  localStorage: 1,
  sessionStorage: 0,
  databases: 1,
  records: 1,
  caches: 0,
  cacheEntries: 0,
};
const ssoReplies = (cookieNames: string[] = []) => [
  { type: "capture-storage", localStorage: SSO_LOCAL, sessionStorage: {} },
  { type: "capture-database", database: SSO_DATABASE },
  { type: "capture-records", database: "idp", store: "session", records: SSO_RECORDS },
  { type: "captured", counts: SSO_COUNTS, cookieNames },
];

beforeEach(() => {
  fakeBrowser.reset();
});

/**
 * A capture whose window also visited `visited`, each answering in the helper tab with `answer`;
 * the helper's navigations to a page in `down` fail as a server that drops the connection.
 */
function capturing(
  visited: (string | Visit)[],
  answer = (_origin: string) => ssoReplies(),
  down: string[] = [],
  session: { tabs?: TabVisits[]; closing?: boolean } = {},
) {
  const setup = chrome();
  const tabs = fakeHelperTabs();
  const barrier = fakeBarrierApi();
  const navigation = fakeNavigationApi();
  const commands: { origin: string; command: { type: string } }[] = [];
  const agents = helperNavigation(navigation, tabs, (command) => {
    const origin = agents.at(-1)?.sender?.origin ?? "";
    commands.push({ origin, command });
    return command.type === "capture" ? answer(origin) : [];
  });
  const commit = navigation.update;
  navigation.update = async (tabId, url) => {
    if (!down.includes(url)) return commit(tabId, url);
    navigation.updates.push({ tabId, url });
    navigation.onErrorOccurred.emit({ tabId, frameId: 0, error: "net::ERR_EMPTY_RESPONSE" });
  };
  const captures = memoryCaptures();
  const visits = memoryVisits(
    4,
    visited.map((each) => (typeof each === "string" ? { origin: each } : each)),
    session.tabs,
  );
  const origins = { visits, helper: { tabs, barrier, navigation } };
  const deps = { ...setup, captures, origins, boundMs: 5_000, closing: session.closing };
  const running = captureIdentity("identity-a", MANAGED, deps, "op-7");
  const answerTarget = async () => {
    await vi.waitFor(() => expect(setup.agent.posted).toHaveLength(1));
    const operation = { operationId: "op-7", generation: 4 };
    for (const reply of completeReplies) setup.agent.onMessage.emit({ ...reply, ...operation });
  };
  return { running, answerTarget, setup, tabs, barrier, navigation, captures, commands, agents };
}

test("saves every other visited origin through the helper tab, the target first", async () => {
  const run = capturing([ORIGIN, SSO]);
  run.setup.cookies.jar = [];
  await run.answerTarget();
  const summary = await run.running;
  expect(run.tabs.opened).toEqual([{ tabId: 100, windowId: 9 }]);
  expect(run.tabs.closed).toEqual([100]);
  expect(run.commands.map(({ origin, command }) => `${origin} ${command.type}`)).toEqual([
    `${SSO} probe`,
    `${SSO} capture`,
  ]);
  expect(run.commands[1]?.command).toMatchObject({ operationId: "op-7", generation: 4 });
  expect(run.barrier.rules.size).toBe(0);
  const complete = run.captures.headers.at(-1);
  expect(complete?.origins).toEqual([
    {
      origin: ORIGIN,
      localStorage: LOCAL,
      sessionStorage: SESSION,
      indexedDB: [DATABASE],
      caches: [],
    },
    {
      origin: SSO,
      localStorage: SSO_LOCAL,
      sessionStorage: {},
      indexedDB: [SSO_DATABASE],
      caches: [],
    },
  ]);
  expect(run.captures.parts.filter(({ origin }) => origin === SSO)).toEqual([
    { origin: SSO, database: "idp", store: "session", records: SSO_RECORDS },
  ]);
  // The counts and the size add up over every origin.
  expect(summary).toMatchObject({
    localStorage: COUNTS.localStorage + 1,
    databases: COUNTS.databases + 1,
    records: COUNTS.records + 1,
    caches: COUNTS.caches,
  });
  expect(summary.bytes).toBeGreaterThan(approximateBytes([LOCAL, SESSION, RECORDS]));
  expect(run.agents.every(({ disconnected }) => disconnected)).toBe(true);
});

test("checks the cookies each visited origin's page showed against its own host", async () => {
  const run = capturing([SSO], () => ssoReplies(["idp_theme"]));
  run.setup.cookies.jar = [];
  await run.answerTarget();
  await expect(run.running).rejects.toMatchObject({
    name: "CookiesNotReadable",
    message: expect.stringContaining('"idp_theme"'),
  });
  expect(run.captures.calls.at(-1)).toBe("discard");
});

/** The unsupported items that name a left-out origin, beside the target's own cache entries. */
const left = ({ adapter }: { adapter: string }) => adapter === "origins";

test("a visited origin whose page fails is left out and named, and the rest is published", async () => {
  const run = capturing([CDN, SSO], (origin) =>
    origin === CDN ? [...ssoReplies().slice(0, 3), capturedWith({ records: 9 })] : ssoReplies(),
  );
  run.setup.cookies.jar = [];
  await run.answerTarget();
  const summary = await run.running;
  const reason = "The page's data did not all arrive.";
  expect(summary.skipped).toEqual([
    { origin: CDN, work: "save", step: "save", reason, kept: false },
  ]);
  const complete = run.captures.headers.at(-1);
  expect(complete?.origins.map(({ origin }) => origin)).toEqual([ORIGIN, SSO]);
  expect(complete?.unsupported.filter(left)).toEqual([{ adapter: "origins", item: CDN, reason }]);
  // The records the failed page did send are dropped, so the capture holds none of the origin.
  expect(run.captures.dropParts).toHaveBeenCalledWith(complete?.id, CDN);
  expect(run.captures.parts.some(({ origin }) => origin === CDN)).toBe(false);
  expect(run.captures.publish).toHaveBeenCalled();
  expect(run.tabs.closed).toEqual([100]);
  expect(run.barrier.rules.size).toBe(0);
});

const CDN_SAVED: OriginCapture = {
  origin: CDN,
  localStorage: { cdn: "A" },
  sessionStorage: {},
  indexedDB: [
    {
      ...SSO_DATABASE,
      stores: [
        { name: "session", keyPath: null, autoIncrement: false, indexes: [], records: SSO_RECORDS },
      ],
    },
  ],
  caches: [{ name: "v1", entries: [] }],
};

/** The identity's last published capture, which held `CDN_SAVED`. */
const previous = (): IdentityCapture => ({
  formatVersion: 1,
  id: "capture-old",
  identityId: "identity-a",
  url: `${ORIGIN}/app/`,
  status: "complete",
  startedAt: 1,
  endedAt: 2,
  adapters: [],
  valueTypes: [],
  cookies: [],
  origins: [CDN_SAVED],
  unsupported: [],
});

test("keeps an unreachable origin's last saved storage after trying its root and its last page", async () => {
  const down = [`${CDN}/`, `${CDN}/assets`];
  const run = capturing([{ origin: CDN, url: `${CDN}/assets` }], () => ssoReplies(), down);
  run.captures.read.mockResolvedValue(previous());
  run.setup.cookies.jar = [];
  await run.answerTarget();
  const summary = await run.running;
  expect(run.navigation.updates.map(({ url }) => url)).toEqual(down);
  const reason = "The page did not load (net::ERR_EMPTY_RESPONSE).";
  expect(summary.skipped).toEqual([
    { origin: CDN, work: "save", step: "navigate", reason, kept: true },
  ]);
  const complete = run.captures.headers.at(-1);
  expect(complete?.origins.at(-1)).toEqual({
    ...CDN_SAVED,
    indexedDB: [SSO_DATABASE],
    caches: [],
  });
  expect(complete?.unsupported.filter(left)).toEqual([]);
  expect(run.captures.parts.filter(({ origin }) => origin === CDN)).toEqual([
    { origin: CDN, database: "idp", store: "session", records: SSO_RECORDS },
    { origin: CDN, cache: { name: "v1", entries: [] } },
  ]);
  expect(run.captures.read).toHaveBeenCalledWith("identity-a");
  expect(summary).toMatchObject({
    localStorage: COUNTS.localStorage + 1,
    caches: COUNTS.caches + 1,
  });
  expect(run.barrier.rules.size).toBe(0);
});

test("an origin the last start could not restore keeps its saved storage without a visit", async () => {
  const run = capturing([
    { origin: CDN, carry: true },
    { origin: SSO, carry: true },
  ]);
  run.captures.read.mockResolvedValue(previous());
  run.setup.cookies.jar = [];
  await run.answerTarget();
  const summary = await run.running;
  expect(run.tabs.open).not.toHaveBeenCalled();
  expect(summary.skipped).toMatchObject([
    { origin: CDN, step: "not-restored", kept: true },
    { origin: SSO, step: "not-restored", kept: false },
  ]);
  const complete = run.captures.headers.at(-1);
  expect(complete?.origins.map(({ origin }) => origin)).toEqual([ORIGIN, CDN]);
  expect(complete?.unsupported.filter(left)).toMatchObject([{ adapter: "origins", item: SSO }]);
});

test("a window that visited only its target opens no helper tab", async () => {
  const run = capturing([ORIGIN]);
  await run.answerTarget();
  await expect(run.running).resolves.toMatchObject(COUNTS);
  expect(run.tabs.open).not.toHaveBeenCalled();
  expect(run.captures.headers.at(-1)?.origins.map(({ origin }) => origin)).toEqual([ORIGIN]);
});

test("a tab a closing capture moved comes back to its page when the capture fails", async () => {
  const run = capturing([ORIGIN], undefined, [], {
    tabs: [{ tabId: 7, visits: [{ origin: SSO }] }],
    closing: true,
  });
  run.navigation.failUpdate = new Error("No tab with id: 7.");
  run.captures.publish.mockRejectedValueOnce(new Error("QuotaExceededError"));
  await run.answerTarget();
  await expect(run.running).rejects.toThrow("QuotaExceededError");
  expect(run.setup.api.navigate.mock.calls).toEqual([[7, `${ORIGIN}/app/`]]);
});

test("a closing capture leaves the moved tabs to the close, and another moves none", async () => {
  const tabVisits = [{ tabId: 7, visits: [{ origin: SSO }] }];
  for (const closing of [false, true]) {
    const run = capturing([ORIGIN], undefined, [], { tabs: tabVisits, closing });
    run.navigation.failUpdate = new Error("No tab with id: 7.");
    await run.answerTarget();
    const summary = await run.running;
    expect(summary.away).toEqual(closing ? [{ tabId: 7, url: `${ORIGIN}/app/` }] : []);
    expect(run.setup.api.discard).toHaveBeenCalledTimes(closing ? 1 : 0);
    expect(run.setup.api.navigate).not.toHaveBeenCalled();
    const unsupported = run.captures.headers.at(-1)?.unsupported ?? [];
    expect(unsupported.filter(({ adapter }) => adapter === "tabs")).toMatchObject([
      { item: `window 1, tab 1, ${SSO}` },
    ]);
  }
});
