import { approximateBytes } from "@recnrun/domain";
import type { ManagedWindowState } from "@recnrun/domain";
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

/** A capture whose window also visited `visited`, each answering in the helper tab with `answer`. */
function capturing(visited: string[], answer = (_origin: string) => ssoReplies()) {
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
  const captures = memoryCaptures();
  const origins = { visits: memoryVisits(4, visited), helper: { tabs, barrier, navigation } };
  const deps = { ...setup, captures, origins, boundMs: 5_000 };
  const running = captureIdentity("identity-a", MANAGED, deps, "op-7");
  const answerTarget = async () => {
    await vi.waitFor(() => expect(setup.agent.posted).toHaveLength(1));
    const operation = { operationId: "op-7", generation: 4 };
    for (const reply of completeReplies) setup.agent.onMessage.emit({ ...reply, ...operation });
  };
  return { running, answerTarget, setup, tabs, barrier, captures, commands, agents };
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

test("a visited origin that cannot be saved fails the capture, naming it, and publishes nothing", async () => {
  const run = capturing([SSO, CDN], (origin) =>
    origin === CDN ? [capturedWith({ records: 9 })] : ssoReplies(),
  );
  await run.answerTarget();
  await expect(run.running).rejects.toMatchObject({
    name: "VisitedOriginFailed",
    message: `Could not save the site data of ${CDN} at its save step: The page's data did not all arrive.`,
  });
  expect(run.captures.publish).not.toHaveBeenCalled();
  expect(run.captures.calls.at(-1)).toBe("discard");
  expect(run.tabs.closed).toEqual([100]);
  expect(run.barrier.rules.size).toBe(0);
});

test("a window that visited only its target opens no helper tab", async () => {
  const run = capturing([ORIGIN]);
  await run.answerTarget();
  await expect(run.running).resolves.toMatchObject(COUNTS);
  expect(run.tabs.open).not.toHaveBeenCalled();
  expect(run.captures.headers.at(-1)?.origins.map(({ origin }) => origin)).toEqual([ORIGIN]);
});
