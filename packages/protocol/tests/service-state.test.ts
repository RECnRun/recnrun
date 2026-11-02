import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import {
  SERVICE_COMMANDS,
  parseServiceLock,
  parseServiceState,
  type ServiceLock,
  type ServiceState,
} from "../src/index.ts";

const state: ServiceState = {
  schemaVersion: 1,
  pid: 4242,
  port: 47_123,
  token: "a".repeat(43),
  startedAt: "2026-11-02T10:00:00.000Z",
  serviceVersion: "0.0.0",
};
const lock: ServiceLock = {
  schemaVersion: 1,
  pid: 4242,
  nonce: "n-1",
  createdAt: "2026-11-02T10:00:00.000Z",
};

test("accepts the state a running service writes", () => {
  expect(parseServiceState(state)).toEqual({ ok: true, value: state });
});

test.each([
  ["a short token", { token: "short" }],
  ["a token with spaces", { token: `${"a".repeat(40)} b c` }],
  ["port zero", { port: 0 }],
  ["a port above 65535", { port: 70_000 }],
  ["a negative pid", { pid: -1 }],
  ["another schema version", { schemaVersion: 2 }],
  ["an unknown field", { host: "0.0.0.0" }],
])("rejects a state with %s", (_name, change) => {
  const parsed = parseServiceState({ ...state, ...change });
  expect(parsed.ok).toBe(false);
  expect(parsed.ok ? "" : parsed.message).not.toBe("");
});

test("accepts a lock and rejects one without a nonce", () => {
  expect(parseServiceLock(lock)).toEqual({ ok: true, value: lock });
  expect(parseServiceLock({ ...lock, nonce: "" }).ok).toBe(false);
});

test("health reports the pid, the uptime, and Chrome discovery", () => {
  const { result } = SERVICE_COMMANDS.health;
  const health = {
    status: "ok",
    serviceVersion: "0.0.0",
    protocolVersion: 1,
    pid: 4242,
    uptimeMs: 12,
    chrome: {
      ok: false,
      code: "missing-file",
      remedy: "Enable remote debugging at chrome://inspect/#remote-debugging and keep Chrome open.",
      userDataDir: "/home/ana/.config/google-chrome",
    },
  };
  expect(v.safeParse(result, health).success).toBe(true);
  const { chrome: _chrome, ...withoutChrome } = health;
  expect(v.safeParse(result, withoutChrome).success).toBe(false);
  expect(v.safeParse(result, { ...health, uptimeMs: -1 }).success).toBe(false);
});
