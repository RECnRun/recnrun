import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import {
  BindingClassificationSchema,
  BindingsFileSchema,
  ProfileBindingSchema,
  parseBindingsFile,
  type ProfileBinding,
} from "../src/index.ts";

const ana: ProfileBinding = {
  name: "Ana (approver)",
  userDataDir: "/home/ana/.config/google-chrome",
  wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
  browserContextIds: ["C1"],
  chrome: "Chrome/156.0.8078.79",
  createdAt: "2026-11-02T10:00:00.000Z",
  lastSeenAt: "2026-11-02T10:00:00.000Z",
};

test("accepts a binding with a friendly name", () => {
  expect(v.parse(ProfileBindingSchema, ana)).toEqual(ana);
});

test.each([
  ["an empty name", { name: "" }],
  ["a name with surrounding spaces", { name: " Ana " }],
  ["a non-loopback endpoint", { wsEndpoint: "ws://10.0.0.2:9222/devtools/browser/abc" }],
  ["an endpoint without a browser path", { wsEndpoint: "ws://127.0.0.1:9222/" }],
  ["a time that is not ISO", { lastSeenAt: "yesterday" }],
  ["an extra key", { flowId: "pedido" }],
])("rejects a binding with %s", (_, change) => {
  expect(v.safeParse(ProfileBindingSchema, { ...ana, ...change }).success).toBe(false);
});

test("a bindings file carries schemaVersion 1 and unique names", () => {
  const bob = { ...ana, name: "Bob", wsEndpoint: "ws://127.0.0.1:9333/devtools/browser/def" };
  expect(v.parse(BindingsFileSchema, { schemaVersion: 1, bindings: [ana, bob] }).bindings).toEqual([
    ana,
    bob,
  ]);
  expect(v.safeParse(BindingsFileSchema, { schemaVersion: 2, bindings: [] }).success).toBe(false);
  expect(v.safeParse(BindingsFileSchema, { schemaVersion: 1, bindings: [ana, ana] }).success).toBe(
    false,
  );
});

test("parseBindingsFile answers the file or a readable message", () => {
  expect(parseBindingsFile({ schemaVersion: 1, bindings: [ana] })).toEqual({
    ok: true,
    file: { schemaVersion: 1, bindings: [ana] },
  });
  const duplicate = parseBindingsFile({ schemaVersion: 1, bindings: [ana, ana] });
  expect(duplicate).toEqual({ ok: false, message: expect.stringContaining("unique") });
  expect(parseBindingsFile("not json")).toMatchObject({ ok: false });
});

test("a restarted classification names at least one change", () => {
  const wsEndpoint = "ws://127.0.0.1:9444/devtools/browser/new";
  const restarted = { status: "stale-restarted", wsEndpoint, changed: ["endpoint"] };
  expect(v.parse(BindingClassificationSchema, restarted)).toEqual(restarted);
  expect(v.safeParse(BindingClassificationSchema, { ...restarted, changed: [] }).success).toBe(
    false,
  );
});
