import { beforeEach, expect, test } from "vite-plus/test";
import { runOriginAgent } from "@/origin/agent";
import type { OriginStores } from "@/origin/restore";
import { fakePort } from "./fake-port";
import { clearCaches, clearDatabases, entriesOf, memoryStorage, settled } from "./origin-storage";

const operation = { operationId: "op-1", generation: 2 };
const probe = { type: "probe", ...operation, probe: new Date(0) };
const echo = { ...probe, type: "probe-echo" };
const NONE = {
  localStorage: 0,
  sessionStorage: 0,
  databases: 0,
  records: 0,
  caches: 0,
  cacheEntries: 0,
};

const sessionRestore = {
  type: "restore",
  ...operation,
  scope: "session",
  payload: { localStorage: {}, sessionStorage: { tab: "second" }, indexedDB: [], caches: [] },
};

let stores: OriginStores;

/** An agent past the link probe, its echo already posted. */
function linked() {
  const agent = fakePort();
  runOriginAgent(agent, stores, () => "sid=1");
  agent.onMessage.emit(probe);
  return agent;
}

/** The origin as another tab already restored it: localStorage and a database the tab shares. */
async function sharedOrigin() {
  stores.localStorage.setItem("theme", "dark");
  const opening = indexedDB.open("app", 1);
  opening.addEventListener("upgradeneeded", () => opening.result.createObjectStore("kv"));
  (await settled(opening)).close();
}

beforeEach(async () => {
  await clearDatabases();
  await clearCaches();
  stores = { localStorage: memoryStorage(), sessionStorage: memoryStorage(), indexedDB, caches };
});

test("a session capture sends the tab's own sessionStorage alone, never what the origin shares", async () => {
  await sharedOrigin();
  stores.sessionStorage.setItem("tab", "second");
  const agent = linked();
  agent.onMessage.emit({ type: "capture", ...operation, scope: "session" });
  await expect
    .poll(() => agent.posted)
    .toEqual([
      echo,
      {
        type: "capture-storage",
        ...operation,
        localStorage: {},
        sessionStorage: { tab: "second" },
      },
      {
        type: "captured",
        ...operation,
        counts: { ...NONE, sessionStorage: 1 },
        cookieNames: [],
      },
    ]);
});

test("a session restore writes the tab's sessionStorage beside the data the origin already holds", async () => {
  await sharedOrigin();
  const agent = linked();
  agent.onMessage.emit(sessionRestore);
  await expect
    .poll(() => agent.posted)
    .toEqual([echo, { type: "restored", ...operation, counts: { ...NONE, sessionStorage: 1 } }]);
  expect(entriesOf(stores.sessionStorage)).toEqual({ tab: "second" });
  expect(entriesOf(stores.localStorage)).toEqual({ theme: "dark" });
});

test("a session restore refuses a tab whose sessionStorage already holds data", async () => {
  stores.sessionStorage.setItem("tab", "stale");
  const agent = linked();
  agent.onMessage.emit(sessionRestore);
  await expect
    .poll(() => agent.posted)
    .toEqual([echo, { type: "failed", ...operation, error: "check: OriginNotEmpty" }]);
  expect(entriesOf(stores.sessionStorage)).toEqual({ tab: "stale" });
});
