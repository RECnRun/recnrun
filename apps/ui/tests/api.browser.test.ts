import { expect, test, vi } from "vite-plus/test";
import { readToken } from "@/api/api";
import { ApiError } from "@/api/error";
import { createEventBus } from "@/api/events";
import { createCall } from "@/api/http";

const HEALTH = {
  status: "ok",
  serviceVersion: "0.0.0",
  protocolVersion: 1,
  pid: 42,
  uptimeMs: 10,
  chrome: {
    ok: false,
    code: "missing-file",
    remedy: "Enable remote debugging.",
    userDataDir: "/u",
  },
};

function answering(body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body));
  return { fetch, call: createCall({ token: "secret-token", fetch }) };
}

test("sends a request envelope with the bearer token and returns the validated result", async () => {
  const { fetch, call } = answering({ requestId: "r", ok: true, result: HEALTH });
  await expect(call("health", {})).resolves.toEqual(HEALTH);
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url).toBe("/api");
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
  expect(JSON.parse(init?.body as string)).toMatchObject({ command: "health", params: {} });
});

test("rejects a result outside the command's schema as an invalid response", async () => {
  const { call } = answering({ requestId: "r", ok: true, result: { ...HEALTH, pid: "x" } });
  const error = await call("health", {}).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code: "invalid-response" });
});

test("rejects a body that is not a response envelope", async () => {
  const { call } = answering({ hello: "world" });
  await expect(call("health", {})).rejects.toMatchObject({ code: "invalid-response" });
});

test("surfaces the service's error code and message", async () => {
  const error = { code: "not-found", message: "No flow named x.", retryable: false };
  const { call } = answering({ requestId: "r", ok: false, error });
  await expect(call("flow.get", { flowId: "x" })).rejects.toMatchObject({
    code: "not-found",
    message: "No flow named x.",
  });
});

test("refuses invalid params before sending anything", async () => {
  const { fetch, call } = answering({});
  await expect(call("flow.get", { flowId: "has spaces" })).rejects.toMatchObject({
    code: "invalid-request",
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("reports an unreachable service", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Promise.reject(new TypeError("down")));
  const call = createCall({ token: "t", fetch });
  await expect(call("health", {})).rejects.toMatchObject({ code: "unreachable" });
});

test("reports a 404 or an empty body from /api as an unreachable service", async () => {
  for (const response of [new Response("Not found.", { status: 404 }), new Response(null)]) {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
    const call = createCall({ token: "t", fetch });
    await expect(call("health", {})).rejects.toMatchObject({ code: "unreachable" });
  }
});

test("sends the protocol's params and the lease fence in the envelope", async () => {
  const picking = { sessionId: "session-1", picking: true };
  const { fetch, call } = answering({ requestId: "r", ok: true, result: picking });
  const lease = {
    leaseId: "lease-1",
    fencingToken: 3,
    targetId: "tab-1",
    holderId: "person",
    kind: "manual" as const,
    acquiredAt: 1,
    expiresAt: 2,
  };
  await expect(call("picker.start", { sessionId: "session-1" }, { lease })).resolves.toEqual(
    picking,
  );
  expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({
    command: "picker.start",
    params: { sessionId: "session-1" },
    lease: { leaseId: "lease-1", fencingToken: 3 },
  });
});

test("reads the token from the page's meta tag", () => {
  const doc = document.implementation.createHTMLDocument("x");
  expect(readToken(doc)).toBeUndefined();
  doc.head.innerHTML = '<meta name="recnrun-token" content="abc">';
  expect(readToken(doc)).toBe("abc");
});

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor() {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  push(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

function socket(index: number): FakeSocket {
  const found = FakeSocket.all[index];
  if (!found) throw new Error(`No socket ${index}.`);
  return found;
}

const SUMMARY = {
  schemaVersion: 1,
  runId: "run-1",
  flowId: "login",
  status: "passed",
  exitCode: 0,
  startedAt: "2026-11-02T10:00:00.000Z",
  endedAt: "2026-11-02T10:00:01.000Z",
  counts: {
    total: 1,
    pending: 0,
    running: 0,
    passed: 1,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    indeterminate: 0,
  },
  failures: [],
};

const finished = (runId: string) => ({
  type: "run.finished",
  runId,
  summary: { ...SUMMARY, runId },
});

test("delivers valid push messages, drops others, subscribes, and reconnects", async () => {
  FakeSocket.all = [];
  const bus = createEventBus({ url: "ws://x/ws", connect: () => new FakeSocket(), retryMs: 1 });
  const seen: unknown[] = [];
  bus.on("run.finished", (message) => seen.push(message));
  const first = socket(0);
  first.onopen?.(new Event("open"));
  expect(JSON.parse(first.sent[0] ?? "{}")).toMatchObject({ command: "events.subscribe" });
  first.push(finished("run-1"));
  first.push({ type: "run.finished", runId: "run-x" });
  first.push({ requestId: "r", ok: true, result: { subscriptionId: "subscription-1" } });
  expect(seen).toEqual([finished("run-1")]);
  first.onclose?.(new CloseEvent("close"));
  await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
  socket(1).push(finished("run-2"));
  expect(seen).toEqual([finished("run-1"), finished("run-2")]);
  bus.close();
});
