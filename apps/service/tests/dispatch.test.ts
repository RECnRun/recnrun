import { CAPABILITY_MATRIX, type DiscoveryResult } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { dispatch, type CommandHandlers } from "@/dispatch";
import { createHandlers } from "@/handlers";

const chrome: DiscoveryResult = {
  ok: false,
  code: "stale-file",
  remedy: "Enable remote debugging at chrome://inspect/#remote-debugging and keep Chrome open.",
  userDataDir: "/profiles/a",
};
const handlers = createHandlers({ startedAt: 1000, now: () => 1250, discover: async () => chrome });
const request = (command: string, params: unknown = {}) => ({ requestId: "r-1", command, params });

test("runs health and validates its result", async () => {
  expect(await dispatch(request("health"), handlers)).toEqual({
    requestId: "r-1",
    ok: true,
    result: {
      status: "ok",
      serviceVersion: "0.0.0",
      protocolVersion: 1,
      pid: process.pid,
      uptimeMs: 250,
      chrome,
    },
  });
});

test("capabilities.get returns the matrix", async () => {
  expect(await dispatch(request("capabilities.get"), handlers)).toMatchObject({
    ok: true,
    result: CAPABILITY_MATRIX,
  });
});

test.each([
  ["not an object", "health", "none"],
  ["no request id", { command: "health", params: {} }, "none"],
  ["an empty request id", { requestId: "", command: "health", params: {} }, "none"],
  ["an unknown command", request("shell.exec"), "r-1"],
  ["params the command does not take", request("health", { all: true }), "r-1"],
])("%s is invalid-request", async (_name, input, requestId) => {
  expect(await dispatch(input, handlers)).toMatchObject({
    requestId,
    ok: false,
    error: { code: "invalid-request", retryable: false },
  });
});

test("a command without a handler is capability-unavailable", async () => {
  expect(await dispatch(request("profiles.list"), handlers)).toMatchObject({
    ok: false,
    error: { code: "capability-unavailable", message: "profiles.list is not available yet." },
  });
});

test("a handler that throws is internal and retryable", async () => {
  const failing: CommandHandlers = {
    health: async () => {
      throw new Error("disk on fire");
    },
  };
  expect(await dispatch(request("health"), failing)).toMatchObject({
    ok: false,
    error: { code: "internal", message: "health failed: disk on fire", retryable: true },
  });
});

test("a result that breaks the protocol is never sent", async () => {
  const broken = { health: async () => ({ status: "ok" }) } as unknown as CommandHandlers;
  expect(await dispatch(request("health"), broken)).toMatchObject({
    ok: false,
    error: { code: "internal" },
  });
});
