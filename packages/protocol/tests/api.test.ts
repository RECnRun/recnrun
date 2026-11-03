import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  COMMAND_NAMES,
  RequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  SERVICE_COMMANDS,
  ServiceErrorSchema,
} from "../src/index.ts";

describe("RequestEnvelopeSchema", () => {
  test("accepts a mutation with its lease fence", () => {
    const request = {
      requestId: "req-1",
      command: "session.handoff",
      params: { sessionId: "s-1", to: "manual" },
      lease: { leaseId: "target-1/7", fencingToken: 7 },
    };
    expect(v.parse(RequestEnvelopeSchema, request)).toEqual(request);
  });

  test.each([
    ["an unknown command", { requestId: "r", command: "shell.exec", params: {} }],
    ["an empty request id", { requestId: "", command: "health", params: {} }],
    [
      "an empty lease id",
      { requestId: "r", command: "health", params: {}, lease: { leaseId: "", fencingToken: 1 } },
    ],
  ])("rejects %s", (_name, request) => {
    expect(v.safeParse(RequestEnvelopeSchema, request).success).toBe(false);
  });
});

describe("the command table", () => {
  test("names the commands of PLAN.md F2 to F5", () => {
    expect(COMMAND_NAMES).toEqual(Object.keys(SERVICE_COMMANDS));
    for (const command of [
      "capabilities.get",
      "health",
      "profiles.list",
      "session.start",
      "browser.inspect",
      "browser.act",
      "flow.replay",
      "run.compare",
      "run.queryEvents",
      "issue.createReproducer",
      "locators.validate",
      "functions.register",
      "macros.extract",
    ]) {
      expect(COMMAND_NAMES).toContain(command);
    }
  });

  test("validates the params of a specified command", () => {
    const { params } = SERVICE_COMMANDS["session.handoff"];
    expect(v.safeParse(params, { sessionId: "s-1", to: "agent" }).success).toBe(true);
    expect(v.safeParse(params, { sessionId: "s-1", to: "robot" }).success).toBe(false);
  });

  test("accepts a replay's transient secrets and bounds them", () => {
    const { params } = SERVICE_COMMANDS["flow.replay"];
    const ok = { flowId: "login", inputs: { email: "a@b.c" }, secrets: { pin: "1234" } };
    expect(v.safeParse(params, ok).success).toBe(true);
    const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, "x"]));
    for (const secrets of [
      { pin: 1234 },
      { "not a name": "x" },
      { pin: "x".repeat(4097) },
      tooMany,
    ])
      expect(v.safeParse(params, { flowId: "login", secrets }).success).toBe(false);
  });

  test("validates the result of run.queryEvents as a page of events", () => {
    const { result } = SERVICE_COMMANDS["run.queryEvents"];
    expect(v.safeParse(result, { events: [], nextCursor: "c-2" }).success).toBe(true);
    expect(v.safeParse(result, { events: [{}] }).success).toBe(false);
  });
});

describe("ServiceErrorSchema", () => {
  const error = {
    code: "capability-unavailable",
    message: "IndexedDB capture is planned for F6.",
    step: "salvar",
    capability: "indexeddb",
    retryable: false,
    evidence: ["runs/run-1/coverage.json"],
    alternative: "Assert on the visible result instead.",
  };

  test("carries code, step, capability, retryability, evidence, and alternative", () => {
    expect(v.parse(ServiceErrorSchema, error)).toEqual(error);
  });

  test.each([
    ["no retryable flag", { code: "internal", message: "x" }],
    ["an unknown code", { code: "oops", message: "x", retryable: true }],
    ["an empty message", { code: "internal", message: "", retryable: true }],
  ])("rejects %s", (_name, value) => {
    expect(v.safeParse(ServiceErrorSchema, value).success).toBe(false);
  });

  test("is the payload of a failed response", () => {
    const response = { requestId: "r", ok: false, error };
    expect(v.safeParse(ResponseEnvelopeSchema, response).success).toBe(true);
    expect(v.safeParse(ResponseEnvelopeSchema, { requestId: "r", ok: false }).success).toBe(false);
    expect(
      v.safeParse(ResponseEnvelopeSchema, { requestId: "r", ok: true, result: 1 }).success,
    ).toBe(true);
  });
});
