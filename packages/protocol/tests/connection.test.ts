import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import {
  BrowserHandshakeSchema,
  CdpTargetSchema,
  ConnectionSourceSchema,
  ReconnectResultSchema,
} from "../src/index.ts";

const handshake = {
  endpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
  version: {
    product: "Chrome/156.0.8078.79",
    protocolVersion: "1.3",
    userAgent: "Mozilla/5.0",
    jsVersion: "15.6",
  },
  domains: [
    { domain: "Target", scope: "browser", status: "available" },
    { domain: "Network", scope: "page", status: "unavailable", reason: "no page" },
  ],
};

test("accepts a handshake and drops fields Chrome adds to the version", () => {
  const parsed = v.parse(BrowserHandshakeSchema, {
    ...handshake,
    version: { ...handshake.version, later: true },
  });
  expect(parsed).toEqual(handshake);
});

test("rejects a probe of a domain outside the list", () => {
  const domains = [{ domain: "Tracing", scope: "browser", status: "available" }];
  expect(v.safeParse(BrowserHandshakeSchema, { ...handshake, domains }).success).toBe(false);
});

test("keeps the known fields of a CDP target", () => {
  const target = { targetId: "T1", type: "page", url: "about:blank", title: "", attached: false };
  expect(v.parse(CdpTargetSchema, { ...target, canAccessOpener: false })).toEqual(target);
  expect(v.safeParse(CdpTargetSchema, { ...target, attached: "yes" }).success).toBe(false);
});

test("a source is a user-data dir or an active-port file", () => {
  expect(v.safeParse(ConnectionSourceSchema, { userDataDir: "/p" }).success).toBe(true);
  expect(v.safeParse(ConnectionSourceSchema, { activePortFile: "/p/F" }).success).toBe(true);
  expect(v.safeParse(ConnectionSourceSchema, { port: 9222 }).success).toBe(false);
});

test("a reconnection succeeds with a handshake or names the gone endpoint", () => {
  expect(v.safeParse(ReconnectResultSchema, { ok: true, handshake }).success).toBe(true);
  const gone = { ok: false, code: "endpoint-gone", remedy: "Open Chrome again." };
  expect(v.safeParse(ReconnectResultSchema, gone).success).toBe(true);
  expect(v.safeParse(ReconnectResultSchema, { ...gone, code: "stale-file" }).success).toBe(false);
});
