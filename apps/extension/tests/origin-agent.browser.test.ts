import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ORIGIN_AGENT_PORT } from "@/messaging/origin-protocol";
import { runOriginAgent, startOriginAgent } from "@/origin/agent";
import { fakePort } from "./fake-port";
import { clearDatabases, entriesOf, memoryStorage, settled } from "./origin-storage";

const port = vi.hoisted(() => ({ current: undefined as ReturnType<typeof fakePort> | undefined }));
const browser = vi.hoisted(() => ({ runtime: { connect: vi.fn() } }));

vi.mock("wxt/browser", () => ({ browser }));

const operation = { operationId: "op-1", generation: 2 };
const payload = { localStorage: { token: "secret-1" }, sessionStorage: {}, indexedDB: [] };
const restore = { type: "restore", ...operation, payload };

let stores: { localStorage: Storage; sessionStorage: Storage; indexedDB: IDBFactory };

function started() {
  startOriginAgent();
  const connected = port.current;
  if (connected === undefined) throw new Error("The agent did not connect.");
  return connected;
}

function linked() {
  const agent = fakePort();
  runOriginAgent(agent, stores);
  return agent;
}

beforeEach(async () => {
  await clearDatabases();
  stores = { localStorage: memoryStorage(), sessionStorage: memoryStorage(), indexedDB };
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
  expect(agent.posted).toEqual([]);
  expect(agent.onMessage.listeners.size).toBe(1);
});

test("disconnects on a malformed first command and restores nothing", () => {
  const agent = started();
  agent.onMessage.emit({ ...restore, generation: -1 });
  expect(agent.disconnected).toBe(true);
  expect(agent.onMessage.listeners.size).toBe(0);
  expect(agent.posted).toEqual([]);
});

test("restores the first valid command, replies restored, and ignores any later one", async () => {
  const agent = linked();
  agent.onMessage.emit(restore);
  expect(agent.onMessage.listeners.size).toBe(0);
  await expect
    .poll(() => agent.posted)
    .toEqual([
      {
        type: "restored",
        ...operation,
        counts: { localStorage: 1, sessionStorage: 0, databases: 0, records: 0 },
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
    .toEqual([{ type: "failed", ...operation, error: "check: OriginNotEmpty" }]);
  expect(JSON.stringify(agent.posted)).not.toMatch(/secret/);
  expect(stores.localStorage.length).toBe(0);
});

test("names a thrown value that is no Error only as UnknownError", async () => {
  const agent = runBroken();
  agent.onMessage.emit(restore);
  await expect
    .poll(() => agent.posted)
    .toEqual([{ type: "failed", ...operation, error: "check: UnknownError" }]);
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

const probeReply = { type: "capture-started", ...operation, probe: new Date(0) };

test("captures on a capture command: a probe, each schema, its records in chunks, then the counts", async () => {
  await createApp();
  const agent = linked();
  agent.onMessage.emit(capture);
  const kv = { name: "kv", keyPath: null, autoIncrement: false, indexes: [], records: [] };
  const part = { type: "capture-records", ...operation, database: "app", store: "kv" };
  await expect
    .poll(() => agent.posted)
    .toEqual([
      probeReply,
      {
        type: "capture-database",
        ...operation,
        database: { name: "app", version: 2, stores: [kv] },
      },
      { ...part, records: [1, 2].map((key) => ({ key, value: `value-${key}` })) },
      { ...part, records: [{ key: 3, value: "value-3" }] },
      { type: "captured", ...operation, counts: { databases: 1, records: 3 } },
    ]);
  expect(agent.onMessage.listeners.size).toBe(0);
});

test("a capture that fails replies failed with the step and an error name", async () => {
  vi.spyOn(indexedDB, "databases").mockResolvedValue([{ name: "ghost", version: 1 }]);
  const agent = linked();
  agent.onMessage.emit(capture);
  await expect
    .poll(() => agent.posted)
    .toEqual([probeReply, { type: "failed", ...operation, error: "indexedDB: AbortError" }]);
  vi.restoreAllMocks();
});
