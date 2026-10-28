import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { planLifecycle, WorkspaceOperationSchema } from "../src/index.ts";
import type { LifecycleCommand, LifecycleState } from "../src/index.ts";

const idle: LifecycleState = {
  recording: false,
  foreignWindows: 0,
  open: undefined,
  identities: [
    { id: "a", captured: true },
    { id: "b", captured: true },
    { id: "c", captured: false },
  ],
};
const openA: LifecycleState = { ...idle, open: { identityId: "a" } };
const anonymous: LifecycleState = { ...idle, open: {} };

const refusal = (command: LifecycleCommand, state: LifecycleState) => {
  const plan = planLifecycle(command, state);
  return plan.ok ? undefined : plan.refusal.name;
};
const steps = (command: LifecycleCommand, state: LifecycleState) => {
  const plan = planLifecycle(command, state);
  return plan.ok ? plan.steps : plan.refusal.name;
};

const LEAVE = ["capture", "persist", "close"];

describe("planLifecycle", () => {
  test("switching saves and closes the open identity, then starts the target", () => {
    expect(steps({ kind: "switch", identityId: "b" }, openA)).toEqual([
      ...LEAVE,
      "start-from-capture",
    ]);
    expect(steps({ kind: "switch", identityId: "c" }, openA)).toEqual([...LEAVE, "start-empty"]);
    expect(steps({ kind: "switch", identityId: "b" }, idle)).toEqual(["start-from-capture"]);
  });

  test("suspend saves and closes; resume starts only from a saved capture", () => {
    expect(steps({ kind: "suspend" }, openA)).toEqual(LEAVE);
    expect(steps({ kind: "resume", identityId: "b" }, idle)).toEqual(["start-from-capture"]);
    expect(refusal({ kind: "resume", identityId: "c" }, idle)).toBe("CaptureMissing");
    expect(refusal({ kind: "resume", identityId: "b" }, openA)).toBe("WorkspaceOpen");
    expect(refusal({ kind: "suspend" }, idle)).toBe("NoManagedWindow");
  });

  test("a new identity starts empty, after saving the open one", () => {
    expect(steps({ kind: "new-identity", identityId: "c" }, idle)).toEqual(["start-empty"]);
    expect(steps({ kind: "new-identity", identityId: "c" }, openA)).toEqual([
      ...LEAVE,
      "start-empty",
    ]);
  });

  test("delete removes any identity but the open one, whatever else holds", () => {
    const busy = { ...openA, recording: true, foreignWindows: 2 };
    expect(steps({ kind: "delete-identity", identityId: "b" }, busy)).toEqual(["remove"]);
    expect(refusal({ kind: "delete-identity", identityId: "a" }, openA)).toBe("IdentityOpen");
    expect(steps({ kind: "delete-identity", identityId: "a" }, idle)).toEqual(["remove"]);
  });

  test("refuses every window command while recording or with another Incognito window", () => {
    const commands: LifecycleCommand[] = [
      { kind: "switch", identityId: "b" },
      { kind: "suspend" },
      { kind: "resume", identityId: "b" },
      { kind: "new-identity", identityId: "c" },
    ];
    for (const command of commands) {
      expect(refusal(command, { ...openA, recording: true })).toBe("RecordingInProgress");
      expect(refusal(command, { ...openA, foreignWindows: 1 })).toBe("IncognitoWindowsOpen");
    }
  });

  test("refuses an unknown identity, the open one, and a workspace without an identity", () => {
    expect(refusal({ kind: "switch", identityId: "zz" }, openA)).toBe("IdentityNotFound");
    expect(refusal({ kind: "delete-identity", identityId: "zz" }, idle)).toBe("IdentityNotFound");
    expect(refusal({ kind: "switch", identityId: "a" }, openA)).toBe("IdentityOpen");
    expect(refusal({ kind: "switch", identityId: "b" }, anonymous)).toBe("NoActiveIdentity");
    expect(refusal({ kind: "suspend" }, anonymous)).toBe("NoActiveIdentity");
  });

  test("every refusal carries a message for the user", () => {
    const plan = planLifecycle({ kind: "suspend" }, { ...openA, recording: true });
    expect(plan).toEqual({
      ok: false,
      refusal: { name: "RecordingInProgress", message: "Stop the recording first." },
    });
  });
});

describe("WorkspaceOperationSchema", () => {
  test("records each lifecycle command as its own kind", () => {
    const operation = { id: "op", step: "capture", status: "running", started: 1 };
    for (const kind of ["switch", "suspend", "resume", "new-identity", "delete-identity"]) {
      expect(v.is(WorkspaceOperationSchema, { ...operation, kind })).toBe(true);
    }
    expect(v.is(WorkspaceOperationSchema, { ...operation, kind: "restart" })).toBe(false);
  });
});
