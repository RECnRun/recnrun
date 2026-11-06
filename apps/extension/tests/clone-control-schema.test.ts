import { describe, expect, test } from "vite-plus/test";
import { clonesStatePath, controlPath } from "@/p2p/downloads-rendezvous";
import {
  CloneControlChoiceSchema,
  CloneControlRequestSchema,
  readCloneStatus,
  readClones,
} from "@/p2p/clone-control";
import * as v from "valibot";
import { FINGERPRINT, ME } from "./fake-peer";
import { signAs } from "./test-identity";

const REQ = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W1 = "11111111-1111-4111-8111-111111111111";
const BOOT = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const STATEMENT = await signAs({ profileId: ME, fingerprint: FINGERPRINT });

describe("paths", () => {
  test("a request's files and the clones list sit under the namespace's control folder", () => {
    expect(controlPath("lab-1", REQ, "request.json")).toBe(
      `RECnRun/poc/lab-1/control/${REQ}/request.json`,
    );
    expect(controlPath("lab-1", REQ, "status.json")).toBe(
      `RECnRun/poc/lab-1/control/${REQ}/status.json`,
    );
    expect(clonesStatePath("lab-1")).toBe("RECnRun/poc/lab-1/control/clones.json");
  });

  test("refuse a request id that is not a v4 uuid", () => {
    expect(() => controlPath("lab-1", "../x", "request.json")).toThrow(/Invalid/);
  });
});

describe("CloneControlRequestSchema", () => {
  const request = {
    requestId: REQ,
    kind: "clone-control",
    action: "reopen-visible",
    instanceId: W1,
    namespace: "lab-1",
    masterProfileId: ME,
    masterIdentity: STATEMENT,
    createdAt: 1,
  };

  test("keeps the key order the launcher reads", () => {
    expect(Object.keys(v.parse(CloneControlRequestSchema, request))).toEqual(Object.keys(request));
  });

  test.each(["close", "open-headless", "open-visible", "reopen-headless", "reopen-visible"])(
    "accepts the action %s",
    (action) => {
      expect(v.is(CloneControlChoiceSchema, { requestId: REQ, action, instanceId: W1 })).toBe(true);
    },
  );

  test.each([
    ["an unknown action", { action: "kill" }],
    ["an instance that is no uuid", { instanceId: "w1" }],
    ["an extra key", { extra: 1 }],
  ])("refuses %s", (_name, over) => {
    expect(
      v.is(CloneControlChoiceSchema, { requestId: REQ, action: "close", instanceId: W1, ...over }),
    ).toBe(false);
  });
});

describe("readCloneStatus", () => {
  const text = (over: object = {}) =>
    JSON.stringify({
      requestId: REQ,
      action: "close",
      instanceId: W1,
      state: "done",
      message: "closed w1",
      updatedAt: 1_800_000_000_000,
      ...over,
    });

  test("reads the launcher's answer", () => {
    expect(readCloneStatus(text())?.state).toBe("done");
  });

  test("accepts the empty action and instance of a request the launcher could not read", () => {
    expect(readCloneStatus(text({ action: "", instanceId: "", state: "error" }))?.state).toBe(
      "error",
    );
  });

  test.each([
    ["undefined", undefined],
    ["not json", "{"],
    ["an unknown state", text({ state: "weird" })],
    ["an extra key", text({ extra: 1 })],
  ])("answers undefined for %s", (_name, input) => {
    expect(readCloneStatus(input)).toBeUndefined();
  });
});

describe("readClones", () => {
  const text = (clones: object[] = [], over: object = {}) =>
    JSON.stringify({ clones, updatedAt: 1_800_000_000_000, ...over });
  const row = { name: "w1", instanceId: W1, state: "open", mode: "headless", boot: BOOT };

  test("reads the rows with their state and mode", () => {
    expect(readClones(text([row]))?.clones[0]).toEqual(row);
  });

  test("accepts a closed clone with no mode and no boot", () => {
    const closed = { ...row, state: "closed", mode: "", boot: "" };
    expect(readClones(text([closed]))?.clones[0]?.state).toBe("closed");
  });

  test.each([
    ["undefined", undefined],
    ["not json", "x"],
    ["a duplicate instance", text([row, { ...row, name: "w2" }])],
    ["an unknown mode", text([{ ...row, mode: "tall" }])],
  ])("answers undefined for %s", (_name, input) => {
    expect(readClones(input)).toBeUndefined();
  });
});
