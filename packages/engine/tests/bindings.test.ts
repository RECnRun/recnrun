import { expect, test } from "vite-plus/test";
import type { BrowserHandshake, DiscoveryResult, Flow, ProfileBinding } from "@recnrun/protocol";
import { classifyBinding, detectDuplicateBinding, resolveActorBindings } from "../src/index.ts";

const ana: ProfileBinding = {
  name: "Ana",
  userDataDir: "/profiles/ana",
  wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/ana-1",
  browserContextIds: ["C1"],
  chrome: "Chrome/156.0.8078.79",
  createdAt: "2026-11-02T10:00:00.000Z",
  lastSeenAt: "2026-11-02T10:00:00.000Z",
};
const bob: ProfileBinding = {
  ...ana,
  name: "Bob",
  userDataDir: "/profiles/bob",
  wsEndpoint: "ws://127.0.0.1:9333/devtools/browser/bob-1",
};

function found(port: number, path: string): DiscoveryResult {
  return {
    ok: true,
    wsEndpoint: `ws://127.0.0.1:${port}${path}`,
    userDataDir: ana.userDataDir,
    source: "active-port-file",
    port,
    path,
  };
}

function handshake(product: string): BrowserHandshake {
  return {
    endpoint: ana.wsEndpoint,
    version: { product, protocolVersion: "1.3", userAgent: "Mozilla/5.0" },
    domains: [],
  };
}

test("a candidate under a new name with another endpoint and folder is no duplicate", () => {
  const carol = {
    name: "Carol",
    userDataDir: "/profiles/carol",
    wsEndpoint: "ws://127.0.0.1:1/devtools/browser/c",
  };
  expect(detectDuplicateBinding([ana, bob], carol)).toBeUndefined();
});

test("the same endpoint under another name is a duplicate", () => {
  const candidate = { ...bob, name: "Bob again", userDataDir: "/profiles/elsewhere" };
  expect(detectDuplicateBinding([ana, bob], candidate)).toEqual({
    existing: "Bob",
    field: "wsEndpoint",
  });
});

test("the same profile folder under another name is a duplicate, trailing slash or not", () => {
  const candidate = {
    name: "Ana twice",
    userDataDir: "/profiles/ana/",
    wsEndpoint: "ws://127.0.0.1:9444/devtools/browser/ana-2",
  };
  expect(detectDuplicateBinding([ana, bob], candidate)).toEqual({
    existing: "Ana",
    field: "userDataDir",
  });
});

test("refreshing a binding under its own name is not a duplicate", () => {
  const refreshed: ProfileBinding = { ...ana, lastSeenAt: "2026-11-02T12:00:00.000Z" };
  expect(detectDuplicateBinding([ana, bob], refreshed)).toBeUndefined();
});

test("fresh: the same endpoint path and Chrome version", () => {
  const discovered = found(9222, "/devtools/browser/ana-1");
  expect(classifyBinding(ana, discovered, handshake(ana.chrome))).toEqual({
    status: "fresh",
    wsEndpoint: ana.wsEndpoint,
  });
  expect(classifyBinding(ana, discovered)).toEqual({ status: "fresh", wsEndpoint: ana.wsEndpoint });
});

test("stale-restarted: Chrome answers on another endpoint path, reported with the new endpoint", () => {
  const discovered = found(9555, "/devtools/browser/ana-2");
  expect(classifyBinding(ana, discovered, handshake(ana.chrome))).toEqual({
    status: "stale-restarted",
    wsEndpoint: discovered.ok ? discovered.wsEndpoint : "",
    changed: ["endpoint"],
  });
});

test("stale-restarted: Chrome was updated even when the endpoint path matches", () => {
  const discovered = found(9222, "/devtools/browser/ana-1");
  expect(classifyBinding(ana, discovered, handshake("Chrome/157.0.1.2"))).toEqual({
    status: "stale-restarted",
    wsEndpoint: ana.wsEndpoint,
    changed: ["chrome"],
  });
  const both = classifyBinding(ana, found(9555, "/devtools/browser/x"), handshake("Chrome/157"));
  expect(both).toMatchObject({ status: "stale-restarted", changed: ["endpoint", "chrome"] });
});

test("stale-missing: discovery fails, with its remedy", () => {
  const missing: DiscoveryResult = {
    ok: false,
    code: "stale-file",
    remedy: "Enable remote debugging at chrome://inspect/#remote-debugging and keep Chrome open.",
    userDataDir: ana.userDataDir,
  };
  expect(classifyBinding(ana, missing)).toEqual({
    status: "stale-missing",
    remedy: missing.remedy,
  });
});

const flow: Flow = {
  schemaVersion: 1,
  id: "a-b",
  name: "A then B",
  actors: { a: {}, b: {} },
  inputs: {},
  requirements: [],
  preconditions: [],
  steps: [
    { id: "a-open", actor: "a", action: "navigate", url: "http://127.0.0.1:4600/" },
    {
      id: "twice",
      builtin: "repeat",
      times: 2,
      steps: [{ id: "c-open", actor: "c", action: "navigate", url: "http://127.0.0.1:4600/" }],
    },
    { id: "b-open", actor: "b", action: "navigate", url: "http://127.0.0.1:4600/" },
  ],
};

test("maps each actor of the flow, nested steps included, to a binding name", () => {
  expect(resolveActorBindings(flow, { a: "Ana", b: "Bob", c: "Carol", z: "Unused" })).toEqual({
    ok: true,
    bindings: { a: "Ana", b: "Bob", c: "Carol" },
  });
});

test("fails with the name of the first actor that has no binding", () => {
  expect(resolveActorBindings(flow, { a: "Ana", c: "Carol" })).toEqual({
    ok: false,
    code: "missing-binding",
    actor: "b",
    message: 'The actor "b" has no profile binding; choose one before running the flow.',
  });
  expect(resolveActorBindings(flow, { a: "Ana", b: "Bob" })).toMatchObject({ actor: "c" });
});

test("an inherited object key is not a binding", () => {
  const inherited = Object.create({ a: "Ana" }) as Record<string, string>;
  expect(resolveActorBindings({ ...flow, steps: [] }, inherited)).toMatchObject({ actor: "a" });
});
