import { describe, expect, test } from "vite-plus/test";
import { openCdpChannel } from "../src/cdp-socket.ts";
import { connect, instrument } from "../src/index.ts";
import { isLoopbackEndpoint } from "../src/loopback.ts";
import { playwrightTransport } from "../src/playwright-transport.ts";
import { rawCdpCall } from "../src/raw-cdp.ts";
import { fakeChrome, fakeTransport } from "./fake-cdp.ts";
import { FakeSocket } from "./fake-socket.ts";

const LOOPBACK = [
  "ws://127.0.0.1:9222/devtools/browser/x",
  "ws://[::1]:9222/devtools/browser/x",
  "ws://localhost:9222/devtools/browser/x",
];
const REMOTE = [
  "ws://example.com:9222/devtools/browser/x",
  "wss://127.0.0.1:9222/devtools/browser/x",
  "ws://0.0.0.0:9222/devtools/browser/x",
  "http://127.0.0.1:9222/devtools/browser/x",
  "ws://127.0.0.1@example.com:9222/devtools/browser/x",
  "ws://10.0.0.5:9222/devtools/browser/x",
  "not a url",
];
const REFUSED = { code: "non-loopback-endpoint" };

test.each(LOOPBACK)("%s is loopback", (endpoint) => {
  expect(isLoopbackEndpoint(endpoint)).toBe(true);
});

test.each(REMOTE)("%s is not loopback", (endpoint) => {
  expect(isLoopbackEndpoint(endpoint)).toBe(false);
});

describe.each(REMOTE.slice(0, 3))("%s is refused before any socket exists", (endpoint) => {
  const sockets: string[] = [];
  const createSocket = (url: string) => {
    sockets.push(url);
    return new FakeSocket(url);
  };

  test("by the instrumentation socket", async () => {
    await expect(openCdpChannel(endpoint, createSocket)).rejects.toMatchObject(REFUSED);
    expect(sockets).toEqual([]);
  });

  test("by the raw preflight socket", async () => {
    await expect(
      rawCdpCall(endpoint, "Target.getTargets", { createSocket, timeoutMs: 5 }),
    ).rejects.toMatchObject(REFUSED);
    expect(sockets).toEqual([]);
  });

  test("by connect, before the preflight and the transport", async () => {
    const fake = fakeTransport(fakeChrome());
    await expect(connect(endpoint, { transport: fake.transport })).rejects.toMatchObject(REFUSED);
    expect(fake.preflights).toEqual([]);
    expect(fake.links).toEqual([]);
  });

  test("by the Playwright transport", async () => {
    await expect(playwrightTransport.open(endpoint)).rejects.toMatchObject(REFUSED);
    await expect(playwrightTransport.preflightTargets(endpoint)).rejects.toMatchObject(REFUSED);
  });

  test("by instrument, before its channel opens", async () => {
    const opened: string[] = [];
    const openChannel = (url: string) => {
      opened.push(url);
      return Promise.reject(new Error("opened"));
    };
    await expect(instrument(endpoint, { openChannel })).rejects.toMatchObject(REFUSED);
    expect(opened).toEqual([]);
  });
});

test.each(LOOPBACK)("%s opens its socket", async (endpoint) => {
  const sockets: FakeSocket[] = [];
  const opening = openCdpChannel(endpoint, (url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    queueMicrotask(() => socket.emit("open"));
    return socket;
  });
  await expect(opening).resolves.toBeDefined();
  expect(sockets.map((socket) => socket.url)).toEqual([endpoint]);
});
