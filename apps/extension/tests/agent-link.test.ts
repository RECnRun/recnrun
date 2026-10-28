import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { isExpectedAgent, restoreThroughAgent } from "@/background/workspace/agent-link";
import { fakePort } from "./fake-port";

const ORIGIN = "http://app.localhost:5192";
const EXPECTED = { tabId: 7, documentId: "doc-1", origin: ORIGIN };
const SENDER = { tab: { id: 7 }, frameId: 0, documentId: "doc-1", origin: ORIGIN };
const OPERATION = { id: "op-1", generation: 2 };
const PAYLOAD = { localStorage: { theme: "dark" }, sessionStorage: {}, indexedDB: [] };
const COUNTS = { localStorage: 1, sessionStorage: 0, databases: 0, records: 0 };
const BOUND = 5000;
const reply = { operationId: OPERATION.id, generation: OPERATION.generation };

afterEach(() => {
  vi.useRealTimers();
});

describe("isExpectedAgent", () => {
  test("accepts only the agent in the top frame of the expected document", () => {
    expect(isExpectedAgent(fakePort(SENDER), EXPECTED)).toBe(true);
    for (const sender of [
      { ...SENDER, tab: { id: 8 } },
      { ...SENDER, tab: undefined },
      { ...SENDER, frameId: 1 },
      { ...SENDER, documentId: "doc-2" },
      { ...SENDER, origin: "http://other.localhost:5192" },
      undefined,
    ]) {
      expect(isExpectedAgent(fakePort(sender), EXPECTED), JSON.stringify(sender)).toBe(false);
    }
    expect(isExpectedAgent({ ...fakePort(SENDER), name: "recnrun-site" }, EXPECTED)).toBe(false);
  });
});

describe("restoreThroughAgent", () => {
  test("sends the payload and resolves with the counts of its own operation's reply", async () => {
    const port = fakePort(SENDER);
    const restored = restoreThroughAgent(port, OPERATION, PAYLOAD, BOUND);
    expect(port.posted).toEqual([{ type: "restore", ...reply, payload: PAYLOAD }]);
    // Replies of another operation or generation, and anything malformed, are dropped.
    port.onMessage.emit({ type: "restored", ...reply, operationId: "op-0", counts: COUNTS });
    port.onMessage.emit({ type: "restored", ...reply, generation: 1, counts: COUNTS });
    port.onMessage.emit({ type: "restored", ...reply });
    port.onMessage.emit("restored");
    port.onMessage.emit({ type: "restored", ...reply, counts: COUNTS });
    await expect(restored).resolves.toEqual(COUNTS);
    expect(port.onMessage.listeners.size).toBe(0);
    expect(port.onDisconnect.listeners.size).toBe(0);
  });

  test("rejects with the agent's reason when it failed", async () => {
    const port = fakePort(SENDER);
    const restored = restoreThroughAgent(port, OPERATION, PAYLOAD, BOUND);
    port.onMessage.emit({ type: "failed", ...reply, error: "indexedDB: DataError" });
    await expect(restored).rejects.toMatchObject({
      name: "RestoreFailed",
      message: expect.stringContaining("indexedDB: DataError"),
    });
    expect(port.onMessage.listeners.size).toBe(0);
  });

  test("rejects when the page goes away before replying", async () => {
    const port = fakePort(SENDER);
    const restored = restoreThroughAgent(port, OPERATION, PAYLOAD, BOUND);
    port.onDisconnect.emit();
    await expect(restored).rejects.toMatchObject({ name: "AgentDisconnected" });
    expect(port.onDisconnect.listeners.size).toBe(0);
  });

  test("gives up and disconnects when no reply comes within the bound", async () => {
    vi.useFakeTimers();
    const port = fakePort(SENDER);
    const restored = restoreThroughAgent(port, OPERATION, PAYLOAD, BOUND);
    vi.advanceTimersByTime(BOUND - 1);
    expect(port.disconnected).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(restored).rejects.toMatchObject({ name: "RestoreTimedOut" });
    expect(port.disconnected).toBe(true);
    expect(port.onMessage.listeners.size).toBe(0);
  });
});
