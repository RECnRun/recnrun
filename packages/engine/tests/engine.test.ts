import { expect, test } from "vite-plus/test";
import { PROTOCOL_SCHEMA_VERSION } from "@recnrun/protocol";
import { createEngine, type BrowserAdapter } from "../src/index.ts";

function fakeAdapter() {
  const calls: string[] = [];
  const adapter: BrowserAdapter = {
    connect: async (endpoint) => void calls.push(`connect ${endpoint}`),
    disconnect: async () => void calls.push("disconnect"),
  };
  return { adapter, calls };
}

test("reports the protocol schema version", () => {
  expect(createEngine(fakeAdapter().adapter).version).toBe(PROTOCOL_SCHEMA_VERSION);
});

test("connects and disconnects through the adapter", async () => {
  const { adapter, calls } = fakeAdapter();
  const engine = createEngine(adapter);
  await engine.connect("ws://127.0.0.1:9222/devtools/browser/id");
  await engine.disconnect();
  expect(calls).toEqual(["connect ws://127.0.0.1:9222/devtools/browser/id", "disconnect"]);
});
