import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  GapPayloadSchema,
  LeaseFenceSchema,
  LeaseSchema,
  PAUSE_MODES,
  RequestEnvelopeSchema,
  SERVICE_COMMANDS,
  SessionPausesSchema,
  SessionStatusSchema,
} from "../src/index.ts";

const lease = {
  leaseId: "target-1/3",
  targetId: "target-1",
  holderId: "agent-1",
  kind: "agent",
  fencingToken: 3,
  acquiredAt: 1_700_000_000_000,
  expiresAt: 1_700_000_030_000,
};

const pauses = { pauseStepCreation: "active", pauseReplay: "paused", suspendCapture: "active" };

describe("LeaseSchema", () => {
  test("accepts a lease with its holder, fencing token, and expiry", () => {
    expect(v.parse(LeaseSchema, lease)).toEqual(lease);
  });

  test.each([
    ["a zero fencing token", { ...lease, fencingToken: 0 }],
    ["a fractional fencing token", { ...lease, fencingToken: 1.5 }],
    ["a negative expiry", { ...lease, expiresAt: -1 }],
    ["an unassigned holder", { ...lease, kind: "unassigned" }],
    ["an empty holder id", { ...lease, holderId: "" }],
    ["an unknown key", { ...lease, token: "x" }],
  ])("rejects %s", (_name, value) => {
    expect(v.safeParse(LeaseSchema, value).success).toBe(false);
  });
});

describe("the request envelope", () => {
  const request = {
    requestId: "req-1",
    command: "session.handoff",
    params: { sessionId: "s-1", to: "manual" },
  };

  test("carries the lease id and fencing token of a controlled command", () => {
    const fenced = { ...request, lease: { leaseId: "target-1/3", fencingToken: 3 } };
    expect(v.parse(RequestEnvelopeSchema, fenced)).toEqual(fenced);
  });

  test.each([
    ["an opaque lease token", { ...request, leaseToken: "lease-7" }],
    ["a fence without its token", { ...request, lease: { leaseId: "target-1/3" } }],
    ["a fence without its lease id", { ...request, lease: { fencingToken: 3 } }],
  ])("rejects %s", (_name, value) => {
    expect(v.safeParse(RequestEnvelopeSchema, value).success).toBe(false);
  });

  test("a fence has exactly the lease id and the fencing token", () => {
    expect(Object.keys(LeaseFenceSchema.entries).toSorted()).toEqual(["fencingToken", "leaseId"]);
  });
});

describe("pause modes", () => {
  test("are the three distinct pauses, each with its own state", () => {
    expect(PAUSE_MODES).toEqual(["pauseStepCreation", "pauseReplay", "suspendCapture"]);
    expect(Object.keys(SessionPausesSchema.entries).toSorted()).toEqual(
      [...PAUSE_MODES].toSorted(),
    );
    expect(v.parse(SessionPausesSchema, pauses)).toEqual(pauses);
    const stopped = { ...pauses, pauseReplay: "stopped" };
    expect(v.safeParse(SessionPausesSchema, stopped).success).toBe(false);
  });

  test("resume names the pause it ends", () => {
    const { params } = SERVICE_COMMANDS["session.resume"];
    expect(v.safeParse(params, { sessionId: "s-1", mode: "suspendCapture" }).success).toBe(true);
    expect(v.safeParse(params, { sessionId: "s-1" }).success).toBe(false);
    expect(v.safeParse(params, { sessionId: "s-1", mode: "pauseAll" }).success).toBe(false);
  });

  test("a suspended capture is a gap reason", () => {
    expect(v.safeParse(GapPayloadSchema, { reason: "capture-suspended" }).success).toBe(true);
  });
});

describe("SessionStatusSchema", () => {
  const status = { sessionId: "s-1", state: "paused", control: "agent", pauses, lease };

  test("reports the session state, control, pauses, and lease", () => {
    expect(v.parse(SessionStatusSchema, status)).toEqual(status);
    const unassigned = { sessionId: "s-1", state: "recording", control: "unassigned", pauses };
    expect(v.parse(SessionStatusSchema, unassigned)).toEqual(unassigned);
  });

  test.each([
    ["no pauses", { ...status, pauses: undefined }],
    ["the opaque lease token", { ...status, leaseToken: "lease-7" }],
    [
      "a lease without a fencing token",
      { ...status, lease: { ...lease, fencingToken: undefined } },
    ],
  ])("rejects %s", (_name, value) => {
    expect(v.safeParse(SessionStatusSchema, value).success).toBe(false);
  });
});
