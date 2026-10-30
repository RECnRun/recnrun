import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { BARRIER_DOCUMENT_TYPE, ORIGIN_AGENT_PORT } from "@/messaging/origin-protocol";
import { hideBarrierDocument, runOriginAgent, startOriginAgent } from "@/origin/agent";
import type { OriginStores } from "@/origin/restore";
import { fakePort } from "./fake-port";
import { clearCaches, clearDatabases, entriesOf, memoryStorage, settled } from "./origin-storage";

const port = vi.hoisted(() => ({ current: undefined as ReturnType<typeof fakePort> | undefined }));
const browser = vi.hoisted(() => ({ runtime: { connect: vi.fn() } }));

vi.mock("wxt/browser", () => ({ browser }));

const operation = { operationId: "op-1", generation: 2 };
const payload = {
  localStorage: { token: "secret-1" },
  sessionStorage: {},
  indexedDB: [],
  caches: [],
};
const restore = { type: "restore", ...operation, payload };
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

let stores: OriginStores;

function started() {
  startOriginAgent();
  const connected = port.current;
  if (connected === undefined) throw new Error("The agent did not connect.");
  return connected;
}

/** An agent past the link probe, its echo already posted. */
function linked() {
  const agent = fakePort();
  runOriginAgent(agent, stores, () => "");
  agent.onMessage.emit(probe);
  return agent;
}

beforeEach(async () => {
  await clearDatabases();
  await clearCaches();
  stores = { localStorage: memoryStorage(), sessionStorage: memoryStorage(), indexedDB, caches };
  browser.runtime.connect.mockImplementation(() => {
    port.current = fakePort();
    return port.current;
  });
});

afterEach(() => {
  vi.clearAllMocks();
  port.current = undefined;
});

test("connects to the background and waits, touching nothing, until it gets a command", () => {
  const agent = started();
  expect(browser.runtime.connect).toHaveBeenCalledExactlyOnceWith({ name: ORIGIN_AGENT_PORT });
  // A page of the origin, as in another tab while a barrier is up, stays painted.
  expect(document.documentElement.style.getPropertyValue("display")).toBe("");
  expect(agent.posted).toEqual([]);
  expect(agent.onMessage.listeners.size).toBe(1);
});

test("hides a barrier document only, by the type the barrier gives it", () => {
  expect(BARRIER_DOCUMENT_TYPE).toBe("text/x-recnrun-barrier");
  const root = document.createElement("html");
  hideBarrierDocument({ contentType: BARRIER_DOCUMENT_TYPE, documentElement: root });
  expect(root.style.getPropertyValue("display")).toBe("none");
  expect(root.style.getPropertyPriority("display")).toBe("important");
  const page = document.createElement("html");
  hideBarrierDocument({ contentType: "text/plain", documentElement: page });
  expect(page.style.getPropertyValue("display")).toBe("");
});

test("disconnects, restoring nothing, when the first message is not a valid probe", () => {
  for (const first of [restore, { ...probe, generation: -1 }, "probe"]) {
    const agent = started();
    agent.onMessage.emit(first);
    expect(agent.disconnected, JSON.stringify(first)).toBe(true);
    expect(agent.onMessage.listeners.size).toBe(0);
    expect(agent.posted).toEqual([]);
  }
});

test("echoes the probe as it arrived, Date included, then waits for one command", () => {
  const agent = linked();
  expect(agent.posted).toEqual([echo]);
  expect((agent.posted[0] as typeof echo).probe).toBeInstanceOf(Date);
  expect(agent.onMessage.listeners.size).toBe(1);
  expect(agent.disconnected).toBe(false);
});

test("after the probe, disconnects on a malformed command or one of another operation", () => {
  for (const command of [
    { ...restore, generation: -1 },
    { ...restore, operationId: "op-0" },
    { ...restore, generation: 3 },
    probe,
  ]) {
    const agent = linked();
    agent.onMessage.emit(command);
    expect(agent.disconnected, JSON.stringify(command)).toBe(true);
    expect(agent.onMessage.listeners.size).toBe(0);
    expect(agent.posted).toEqual([echo]);
  }
  expect(stores.localStorage.length).toBe(0);
});

test("restores the first valid command, replies restored, and ignores any later one", async () => {
  const agent = linked();
  agent.onMessage.emit(restore);
  expect(agent.onMessage.listeners.size).toBe(0);
  await expect
    .poll(() => agent.posted)
    .toEqual([
      echo,
      {
        type: "restored",
        ...operation,
        counts: { ...NONE, localStorage: 1 },
      },
    ]);
  expect(entriesOf(stores.localStorage)).toEqual(payload.localStorage);
  expect(agent.disconnected).toBe(false);
});

test("replies failed with the step and reason only, never a stored value", async () => {
  stores.sessionStorage.setItem("left", "secret-9");
  const agent = linked();
  agent.onMessage.emit(restore);
  await expect
    .poll(() => agent.posted)
    .toEqual([echo, { type: "failed", ...operation, error: "check: OriginNotEmpty" }]);
  expect(JSON.stringify(agent.posted)).not.toMatch(/secret/);
  expect(stores.localStorage.length).toBe(0);
});

test("names a thrown value that is no Error only as UnknownError", async () => {
  const agent = runBroken();
  agent.onMessage.emit(restore);
  await expect
    .poll(() => agent.posted)
    .toEqual([echo, { type: "failed", ...operation, error: "check: UnknownError" }]);
});

/** An agent whose storage throws a plain value instead of an Error. */
function runBroken() {
  const agent = fakePort();
  const broken = {
    ...stores,
    get localStorage(): Storage {
      throw "not an Error";
    },
  };
  runOriginAgent(agent, broken);
  agent.onMessage.emit(probe);
  return agent;
}

/** A database `app` at version 2 with one out-of-line store holding three records. */
async function createApp() {
  const opening = indexedDB.open("app", 2);
  opening.addEventListener("upgradeneeded", () => opening.result.createObjectStore("kv"));
  const connection = await settled(opening);
  const kv = connection.transaction("kv", "readwrite").objectStore("kv");
  await Promise.all([1, 2, 3].map((key) => settled(kv.put(`value-${key}`, key))));
  connection.close();
}

const capture = { type: "capture", ...operation, chunk: 2 };

test("captures on a capture command: Web Storage, each schema, its records in chunks, then the counts", async () => {
  await createApp();
  stores.localStorage.setItem("theme", "dark");
  stores.sessionStorage.setItem("draft", "");
  const agent = linked();
  agent.onMessage.emit(capture);
  const kv = { name: "kv", keyPath: null, autoIncrement: false, indexes: [], records: [] };
  const part = { type: "capture-records", ...operation, database: "app", store: "kv" };
  await expect
    .poll(() => agent.posted)
    .toEqual([
      echo,
      {
        type: "capture-storage",
        ...operation,
        localStorage: { theme: "dark" },
        sessionStorage: { draft: "" },
      },
      {
        type: "capture-database",
        ...operation,
        database: { name: "app", version: 2, stores: [kv] },
      },
      { ...part, records: [1, 2].map((key) => ({ key, value: `value-${key}` })) },
      { ...part, records: [{ key: 3, value: "value-3" }] },
      {
        type: "captured",
        ...operation,
        counts: { ...NONE, localStorage: 1, sessionStorage: 1, databases: 1, records: 3 },
        cookieNames: [],
      },
    ]);
  expect(agent.onMessage.listeners.size).toBe(0);
});

test("captures each cache after IndexedDB, one message per cache", async () => {
  const v1 = await caches.open("v1");
  await v1.put("/a", new Response("a", { status: 201, statusText: "Made" }));
  const agent = linked();
  agent.onMessage.emit(capture);
  const entry = {
    request: { url: `${location.origin}/a`, method: "GET", headers: [] },
    response: {
      status: 201,
      statusText: "Made",
      headers: [["content-type", "text/plain;charset=UTF-8"]],
      body: new TextEncoder().encode("a").buffer,
      type: "default",
      url: "",
      redirected: false,
    },
  };
  await expect
    .poll(() => agent.posted.slice(2))
    .toEqual([
      {
        type: "capture-cache",
        ...operation,
        cache: { name: "v1", entries: [entry] },
        unsupported: [],
      },
      {
        type: "captured",
        ...operation,
        counts: { ...NONE, caches: 1, cacheEntries: 1 },
        cookieNames: [],
      },
    ]);
});

test("outside a secure context the agent has no Cache Storage and captures no cache", async () => {
  await caches.open("v1");
  vi.stubGlobal("isSecureContext", false);
  const agent = started();
  agent.onMessage.emit(probe);
  agent.onMessage.emit(capture);
  // The page's real Web Storage holds the runner's own keys; only the cache counts matter here.
  await expect
    .poll(() => agent.posted.at(-1))
    .toMatchObject({ type: "captured", counts: { caches: 0, cacheEntries: 0 } });
  expect(agent.posted.map((reply) => (reply as { type: string }).type)).not.toContain(
    "capture-cache",
  );
  vi.unstubAllGlobals();
});

test("a capture names the cookies the page can read, never their values", async () => {
  const agent = fakePort();
  // Chrome writes a cookie with no name as its value alone (canonical_cookie.cc:126-136).
  runOriginAgent(agent, stores, () => "theme=dark; d_lax=on=1; lone");
  agent.onMessage.emit(probe);
  agent.onMessage.emit(capture);
  await expect
    .poll(() => agent.posted.at(-1))
    .toMatchObject({ type: "captured", cookieNames: ["theme", "d_lax", ""] });
  expect(JSON.stringify(agent.posted)).not.toMatch(/dark|on=1|lone/);
});

test("a capture that fails replies failed with the step and an error name", async () => {
  vi.spyOn(indexedDB, "databases").mockResolvedValue([{ name: "ghost", version: 1 }]);
  const agent = linked();
  agent.onMessage.emit(capture);
  await expect
    .poll(() => agent.posted)
    .toEqual([
      echo,
      { type: "capture-storage", ...operation, localStorage: {}, sessionStorage: {} },
      { type: "failed", ...operation, error: "indexedDB: AbortError" },
    ]);
  vi.restoreAllMocks();
});
