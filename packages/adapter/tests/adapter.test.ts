import type { AdapterEvent, DiscoveryResult } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { createCdpAdapter } from "../src/index.ts";
import { fakeChrome, fakeTransport, now, page } from "./fake-cdp.ts";

const ENDPOINT = "ws://127.0.0.1:9222/devtools/browser/one";
const AGAIN: DiscoveryResult = {
  ok: true,
  wsEndpoint: "ws://127.0.0.1:9333/devtools/browser/two",
  userDataDir: "/p",
  source: "active-port-file",
  port: 9333,
  path: "/devtools/browser/two",
};

function setup(discovered: DiscoveryResult = AGAIN) {
  const chrome = fakeChrome();
  const fake = fakeTransport(chrome);
  const adapter = createCdpAdapter({
    transport: fake.transport,
    now,
    discover: () => Promise.resolve(discovered),
  });
  return { adapter, chrome, ...fake };
}

test("needs a connection before listing targets or reconnecting", async () => {
  const { adapter } = setup();
  await expect(adapter.listTargets()).rejects.toThrow(
    "Not connected to Chrome; call connect() first.",
  );
  await expect(adapter.reconnect()).rejects.toThrow("Not connected to Chrome");
  await expect(adapter.disconnect()).resolves.toBeUndefined();
});

test("discovers through the injected discovery", async () => {
  expect(await setup().adapter.discover({ channel: "beta" })).toEqual(AGAIN);
});

test("connects, lists targets, forwards events, and disconnects", async () => {
  const { adapter, links } = setup();
  const events: AdapterEvent[] = [];
  const stop = adapter.onEvent((event) => events.push(event));
  const handshake = await adapter.connect(ENDPOINT, { source: { userDataDir: "/p" } });
  expect(handshake.version.product).toMatch(/^Chrome\//);
  expect(await adapter.listTargets()).toEqual([expect.objectContaining({ targetId: "P1" })]);
  links[0]?.drop();
  expect(events.map((event) => event.type)).toEqual(["connection.lost"]);
  stop();
  await adapter.disconnect();
  await expect(adapter.listTargets()).rejects.toThrow("Not connected");
});

test("a successful reconnection replaces the connection", async () => {
  const { adapter, chrome, links } = setup();
  await adapter.connect(ENDPOINT, { source: { userDataDir: "/p" } });
  links[0]?.drop();
  chrome.targets = [page("P2")];
  const outcome = await adapter.reconnect();
  expect(outcome).toMatchObject({ ok: true, handshake: { endpoint: AGAIN.wsEndpoint } });
  expect(await adapter.listTargets()).toEqual([expect.objectContaining({ targetId: "P2" })]);
});

test("a failed reconnection reports the endpoint as gone", async () => {
  const stale: DiscoveryResult = {
    ok: false,
    code: "stale-file",
    remedy: "Open Chrome.",
    userDataDir: "/p",
  };
  const { adapter } = setup(stale);
  await adapter.connect(ENDPOINT, { source: { userDataDir: "/p" } });
  expect(await adapter.reconnect()).toEqual({
    ok: false,
    code: "endpoint-gone",
    remedy: "Open Chrome.",
  });
});

test("replays in one tab per connection and needs a connection first", async () => {
  const { adapter, links } = setup();
  await expect(adapter.navigate("http://127.0.0.1:4600/")).rejects.toThrow("Not connected");
  await adapter.connect(ENDPOINT, { source: { userDataDir: "/p" } });
  await adapter.navigate("http://127.0.0.1:4600/a");
  await adapter.navigate("http://127.0.0.1:4600/b");
  links[0]?.drop();
  await adapter.reconnect();
  await adapter.navigate("http://127.0.0.1:4600/c");
  const replayCalls = (index: number) =>
    links[index]?.calls.filter((call) => /openPage|goto/.test(call));
  expect(replayCalls(0)).toEqual([
    "browser openPage",
    "page goto http://127.0.0.1:4600/a",
    "page goto http://127.0.0.1:4600/b",
  ]);
  expect(replayCalls(1)).toEqual(["browser openPage", "page goto http://127.0.0.1:4600/c"]);
});
