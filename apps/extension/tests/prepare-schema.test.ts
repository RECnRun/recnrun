import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { operationPath } from "@/p2p/downloads-rendezvous";
import { MAX_CODE_LENGTH } from "@/p2p/protocol";
import { PrepareChoiceSchema, PrepareStatusSchema, readStatus } from "@/p2p/prepare";

const OP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W1 = "11111111-1111-4111-8111-111111111111";
const BOOT = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const status = {
  operationId: OP,
  step: "open-clone",
  state: "running",
  message: "opened w1",
  clones: [{ name: "w1", instanceId: W1, boot: BOOT, acked: true }],
  updatedAt: 1_800_000_000_000,
};

describe("operationPath", () => {
  test("names the files of one operation beside the registry", () => {
    expect(operationPath("lab-1", OP, "status.json")).toBe(
      `RECnRun/poc/lab-1/ops/${OP}/status.json`,
    );
    expect(operationPath("lab-1", OP, "retry")).toBe(`RECnRun/poc/lab-1/ops/${OP}/retry`);
  });

  test.each(["", "../x", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", `${OP}/x`])(
    "refuses the id %j",
    (id) => expect(() => operationPath("lab-1", id, "request.json")).toThrow(/operation id/),
  );
});

describe("PrepareChoiceSchema", () => {
  const choice = {
    operationId: OP,
    basesDir: "/Users/me/My-Bases",
    baseName: "base-v1",
    clones: 8,
  };
  test("accepts the closed grammar", () => expect(v.is(PrepareChoiceSchema, choice)).toBe(true));
  test("accepts a blank bases folder, the launcher's default", () =>
    expect(v.is(PrepareChoiceSchema, { ...choice, basesDir: "" })).toBe(true));
  test.each([
    { basesDir: "relative" },
    { basesDir: "/a/../b" },
    { basesDir: "/a;rm" },
    { basesDir: "/Users/me/My Bases" },
    { basesDir: "/a/" },
    { basesDir: "/a//b" },
    { basesDir: "/a/./b" },
    { basesDir: "/" },
    { basesDir: "/a:b" },
    { basesDir: `/${"a".repeat(1024)}` },
    { clones: 0 },
    { clones: 9 },
    { clones: 1.5 },
    { baseName: "base-vx" },
    { operationId: "not-a-uuid" },
  ])("refuses %j", (change) =>
    expect(v.is(PrepareChoiceSchema, { ...choice, ...change })).toBe(false),
  );
});

describe("readStatus", () => {
  test("reads the launcher's status", () => {
    expect(readStatus(JSON.stringify(status))).toEqual(status);
  });

  test.each([
    undefined,
    "",
    "{",
    JSON.stringify({ ...status, step: "fly" }),
    JSON.stringify({ ...status, state: "stuck" }),
    JSON.stringify({ ...status, message: 'say "hi"' }),
    JSON.stringify({ ...status, message: "a\\b" }),
    JSON.stringify({ ...status, message: "x".repeat(257) }),
    JSON.stringify({ ...status, extra: 1 }),
    JSON.stringify({ ...status, clones: [{ ...status.clones[0], name: "w9" }] }),
    JSON.stringify({ ...status, clones: [{ ...status.clones[0], boot: "nope" }] }),
  ])("reads %j as no status", (text) => expect(readStatus(text)).toBeUndefined());

  test("refuses a status over the shared maximum", () => {
    const padded = JSON.stringify({ ...status, message: "x" }) + " ".repeat(MAX_CODE_LENGTH);
    expect(readStatus(padded)).toBeUndefined();
  });

  test("refuses a duplicate clone name or instance id", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const twice = (second: object) =>
      JSON.stringify({ ...status, clones: [status.clones[0], { ...status.clones[0], ...second }] });
    expect(readStatus(twice({}))).toBeUndefined();
    expect(readStatus(twice({ instanceId: other }))).toBeUndefined();
    expect(readStatus(twice({ name: "w2" }))).toBeUndefined();
    expect(readStatus(twice({ name: "w2", instanceId: other }))).toBeDefined();
  });

  test("accepts an unacked clone with an empty boot", () => {
    const text = JSON.stringify({
      ...status,
      clones: [{ ...status.clones[0], boot: "", acked: false }],
    });
    expect(v.is(PrepareStatusSchema, JSON.parse(text))).toBe(true);
  });
});
