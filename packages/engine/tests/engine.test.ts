import { expect, test } from "vite-plus/test";
import { PROTOCOL_SCHEMA_VERSION, type BrowserHandshake } from "@recnrun/protocol";
import { createEngine, type BrowserAdapter } from "../src/index.ts";

const HANDSHAKE: BrowserHandshake = {
  endpoint: "ws://127.0.0.1:9222/devtools/browser/id",
  version: { product: "Chrome/156.0.8078.79", protocolVersion: "1.3", userAgent: "Mozilla/5.0" },
  domains: [{ domain: "Target", scope: "browser", status: "available" }],
};

function fakeAdapter() {
  const calls: string[] = [];
  const adapter: BrowserAdapter = {
    discover: () => Promise.reject(new Error("unused")),
    connect: async (endpoint) => {
      calls.push(`connect ${endpoint}`);
      return HANDSHAKE;
    },
    listTargets: () => Promise.resolve([]),
    reconnect: () => Promise.resolve({ ok: false, code: "endpoint-gone", remedy: "unused" }),
    disconnect: async () => void calls.push("disconnect"),
    onEvent: () => () => undefined,
    describeProfile: () => Promise.reject(new Error("unused")),
    inspect: () => Promise.reject(new Error("unused")),
    readAttribute: () => Promise.reject(new Error("unused")),
    tabs: () => Promise.reject(new Error("unused")),
    act: () => Promise.reject(new Error("unused")),
  };
  return { adapter, calls };
}

test("reports the protocol schema version", () => {
  expect(createEngine(fakeAdapter().adapter).version).toBe(PROTOCOL_SCHEMA_VERSION);
});

test("connects and disconnects through the adapter", async () => {
  const { adapter, calls } = fakeAdapter();
  const engine = createEngine(adapter);
  expect(await engine.connect("ws://127.0.0.1:9222/devtools/browser/id")).toEqual(HANDSHAKE);
  await engine.disconnect();
  expect(calls).toEqual(["connect ws://127.0.0.1:9222/devtools/browser/id", "disconnect"]);
});
