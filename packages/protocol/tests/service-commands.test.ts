import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { SERVICE_COMMANDS, ServiceMessageSchema } from "../src/index.ts";

const REVISION = "a".repeat(64);
const AT = "2026-11-02T10:00:00.000Z";
const FLOW = { schemaVersion: 1, id: "f-1", name: "F", steps: [] };

describe("the F2.6 commands", () => {
  test("list, get, save, and import flows", () => {
    const entry = { id: "f-1", name: "F", status: "recorded", revision: REVISION, updatedAt: AT };
    expect(v.safeParse(SERVICE_COMMANDS["flow.list"].result, { flows: [entry] }).success).toBe(
      true,
    );
    expect(v.safeParse(SERVICE_COMMANDS["flow.get"].params, { flowId: "f-1" }).success).toBe(true);
    expect(v.safeParse(SERVICE_COMMANDS["flow.save"].params, { flow: FLOW }).success).toBe(true);
    expect(v.safeParse(SERVICE_COMMANDS["flow.import"].params, { flow: {} }).success).toBe(false);
    const saved = { flowId: "f-1", revision: REVISION };
    expect(v.safeParse(SERVICE_COMMANDS["flow.import"].result, saved).success).toBe(true);
  });

  test("starts and stops the picker of a session", () => {
    const { params, result } = SERVICE_COMMANDS["picker.start"];
    expect(v.safeParse(params, { sessionId: "s-1" }).success).toBe(true);
    expect(v.safeParse(result, { sessionId: "s-1", picking: true }).success).toBe(true);
    expect(v.safeParse(SERVICE_COMMANDS["picker.stop"].params, {}).success).toBe(false);
  });

  test("subscribes to a session or a run", () => {
    const { params, result } = SERVICE_COMMANDS["events.subscribe"];
    expect(v.safeParse(params, { sessionId: "s-1" }).success).toBe(true);
    expect(v.safeParse(params, { runId: "r-1", sessionId: "s-1" }).success).toBe(true);
    expect(v.safeParse(params, { flowId: "f-1" }).success).toBe(false);
    expect(v.safeParse(result, { subscriptionId: "sub-1" }).success).toBe(true);
  });

  test("returns a session's suggestions as a normalization result", () => {
    const { result } = SERVICE_COMMANDS["session.suggestions"];
    expect(v.safeParse(result, { steps: [], excluded: [] }).success).toBe(true);
    expect(v.safeParse(result, { steps: [{}], excluded: [] }).success).toBe(false);
  });
});

describe("ServiceMessageSchema", () => {
  const counts = {
    total: 0,
    pending: 0,
    running: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    indeterminate: 0,
  };
  const summary = {
    schemaVersion: 1,
    runId: "r-1",
    flowId: "f-1",
    status: "passed",
    exitCode: 0,
    startedAt: AT,
    endedAt: AT,
    counts,
    failures: [],
  };

  test("pushes a picked element with its suggested locators", () => {
    const message = {
      type: "picker.picked",
      sessionId: "s-1",
      target: { tag: "button", testId: "submit" },
      locators: { locators: [{ testId: "submit" }] },
    };
    expect(v.safeParse(ServiceMessageSchema, message).success).toBe(true);
  });

  test("pushes the end of a run with its summary", () => {
    const message = { type: "run.finished", runId: "r-1", summary };
    expect(v.safeParse(ServiceMessageSchema, message).success).toBe(true);
    expect(v.safeParse(ServiceMessageSchema, { ...message, type: "run.done" }).success).toBe(false);
  });
});

describe("the F4.1 commands", () => {
  test("duplicates a flow under a new id and reads one of its revisions", () => {
    const duplicate = SERVICE_COMMANDS["flow.duplicate"];
    const copy = { flowId: "f-1", newId: "f-2", name: "Copy" };
    expect(v.safeParse(duplicate.params, copy).success).toBe(true);
    expect(v.safeParse(duplicate.params, { flowId: "f-1", newId: "f 2" }).success).toBe(false);
    expect(v.safeParse(duplicate.result, { flowId: "f-2", revision: REVISION }).success).toBe(true);
    const revision = SERVICE_COMMANDS["flow.getRevision"];
    expect(v.safeParse(revision.params, { flowId: "f-1", revision: REVISION }).success).toBe(true);
    expect(v.safeParse(revision.params, { flowId: "f-1", revision: "latest" }).success).toBe(false);
    expect(v.safeParse(revision.result, { flow: FLOW, revision: REVISION }).success).toBe(true);
    expect(v.safeParse(revision.result, { flow: {}, revision: REVISION }).success).toBe(false);
  });
});
