import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { DiscoveryResultSchema } from "../src/index.ts";

const found = {
  ok: true,
  wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
  userDataDir: "/home/user/.config/google-chrome",
  source: "active-port-file",
  port: 9222,
  path: "/devtools/browser/abc",
};

const failed = {
  ok: false,
  code: "stale-file",
  remedy: "Enable remote debugging at chrome://inspect/#remote-debugging and keep Chrome open.",
  userDataDir: "/home/user/.config/google-chrome",
};

test("accepts a found endpoint and a failure with its remedy", () => {
  expect(v.parse(DiscoveryResultSchema, found)).toEqual(found);
  expect(v.parse(DiscoveryResultSchema, failed)).toEqual(failed);
});

test("accepts a DevToolsActivePort the operating system refuses to let RECnRun read", () => {
  const blocked = { ...failed, code: "unreadable-file" };
  expect(v.parse(DiscoveryResultSchema, blocked)).toEqual(blocked);
});

test.each([
  ["a remote host", { ...found, wsEndpoint: "ws://example.test:9222/devtools/browser/abc" }],
  ["a port out of range", { ...found, port: 70_000 }],
  ["a page path", { ...found, path: "/devtools/page/abc" }],
  ["an unknown code", { ...failed, code: "no-chrome" }],
  ["a failure without a remedy", { ...failed, remedy: "" }],
])("rejects %s", (_name, value) => {
  expect(v.safeParse(DiscoveryResultSchema, value).success).toBe(false);
});
