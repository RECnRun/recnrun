import { MAX_FRAME_PAYLOAD_LENGTH, MAX_HEADER_VALUE_LENGTH, type BodyRef } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import type { BodySink } from "../src/index.ts";
import { capturing, type ReplyingChannel } from "./capture-harness.ts";

const API = "http://127.0.0.1:4600/api/secret";
const SECRET = "Bearer s3cr3t-token";
const SHA = "b".repeat(64);

async function page(options = {}) {
  const harness = await capturing(options);
  harness.channel.attach("S1", { targetId: "T1", type: "page" });
  await harness.handle.settled();
  const payloads = (type: string) =>
    harness.of("network", type).map(({ payload }): Record<string, unknown> => payload);
  return { ...harness, payloads };
}

function exchange(
  channel: ReplyingChannel,
  response: Record<string, unknown> = {},
  requestHeaders: Record<string, string> = {},
) {
  const request = { url: API, method: "GET", headers: requestHeaders };
  channel.emit("Network.requestWillBeSent", { requestId: "R1", request, type: "Fetch" }, "S1");
  channel.emit(
    "Network.responseReceived",
    {
      requestId: "R1",
      type: "Fetch",
      response: { url: API, status: 200, statusText: "OK", mimeType: "text/plain", ...response },
    },
    "S1",
  );
  channel.emit("Network.loadingFinished", { requestId: "R1", encodedDataLength: 9 }, "S1");
}

function sink(reply?: (content: Uint8Array) => Partial<BodyRef> | Error) {
  const puts: { text: string; mime: string; encoding: string }[] = [];
  const blobs: BodySink = {
    put: async (content, meta) => {
      puts.push({ text: Buffer.from(content).toString("latin1"), ...meta });
      const answer = reply?.(content) ?? {};
      if (answer instanceof Error) throw answer;
      return { sha256: SHA, ...meta, size: content.length, condition: "captured", ...answer };
    },
  };
  return { blobs, puts };
}

test("sensitive and session-marked headers are redacted, and long values are clipped", async () => {
  const { channel, handle, payloads, events } = await page({ redactHeaders: ["X-Fixture-Token"] });
  const long = "v".repeat(MAX_HEADER_VALUE_LENGTH + 10);
  exchange(
    channel,
    { headers: { "Set-Cookie": "session=s3cr3t-cookie", "x-fixture-token": "s3cr3t-reply" } },
    { Authorization: SECRET, cookie: "a=s3cr3t-cookie", Accept: "*/*", "X-Long": long },
  );
  await handle.settled();
  expect(payloads("request")[0]).toMatchObject({
    headers: {
      Authorization: "redacted",
      cookie: "redacted",
      Accept: "*/*",
      "X-Long": long.slice(0, MAX_HEADER_VALUE_LENGTH),
    },
    headersTruncated: true,
  });
  expect(payloads("response")[0]).toMatchObject({
    headers: { "Set-Cookie": "redacted", "x-fixture-token": "redacted" },
  });
  expect(payloads("response")[0]?.headersTruncated).toBeUndefined();
  expect(JSON.stringify(events)).not.toContain("s3cr3t");
});

test("a response records its timing and where it came from", async () => {
  const { channel, handle, payloads } = await page();
  const timing = { requestTime: 12.5, dnsStart: -1, sendStart: 0.2, workerFetchStart: -1 };
  exchange(channel, { timing });
  await handle.settled();
  expect(payloads("response")[0]).toMatchObject({
    cache: "network",
    timing: { requestTime: 12.5, dnsStart: -1, sendStart: 0.2 },
  });
  expect(payloads("response")[0]?.timing).not.toHaveProperty("workerFetchStart");
  expect(payloads("response")[0]?.fromCache).toBeUndefined();
});

test.each([
  ["disk", { fromDiskCache: true }],
  ["service-worker", { fromServiceWorker: true }],
  ["prefetch", { fromPrefetchCache: true }],
])("a response served from the %s cache says so", async (cache, flags) => {
  const { channel, handle, payloads } = await page();
  exchange(channel, flags);
  await handle.settled();
  expect(payloads("response")[0]).toMatchObject({ cache, fromCache: true });
});

test("a request served from the memory cache says so", async () => {
  const { channel, handle, payloads } = await page();
  const request = { url: API, method: "GET", headers: {} };
  channel.emit("Network.requestWillBeSent", { requestId: "R1", request, type: "Fetch" }, "S1");
  channel.emit("Network.requestServedFromCache", { requestId: "R1" }, "S1");
  channel.emit(
    "Network.responseReceived",
    { requestId: "R1", response: { url: API, status: 200, statusText: "", mimeType: "" } },
    "S1",
  );
  await handle.settled();
  expect(payloads("response")[0]).toMatchObject({ cache: "memory", fromCache: true });
});

test("with a blob sink, bodies are stored as bytes and the event keeps the reference", async () => {
  const { blobs, puts } = sink();
  const { channel, handle, payloads } = await page({ blobs });
  channel.replies.set("Network.getResponseBody", { body: "héllo", base64Encoded: false });
  exchange(channel);
  await handle.settled();
  expect(puts).toEqual([
    { text: Buffer.from("héllo").toString("latin1"), mime: "text/plain", encoding: "utf8" },
  ]);
  expect(payloads("body")).toEqual([
    {
      requestId: "R1",
      url: API,
      mimeType: "text/plain",
      condition: "captured",
      blob: { sha256: SHA, mime: "text/plain", encoding: "utf8", size: 6, condition: "captured" },
    },
  ]);
});

test("a base64 body is stored decoded, and the sink's truncation is the body's condition", async () => {
  const { blobs, puts } = sink(() => ({ size: 1_000_000, condition: "truncated" }));
  const { channel, handle, payloads } = await page({ blobs });
  channel.replies.set("Network.getResponseBody", { body: "AAEC", base64Encoded: true });
  exchange(channel);
  await handle.settled();
  expect(puts).toEqual([{ text: "\u0000\u0001\u0002", mime: "text/plain", encoding: "binary" }]);
  expect(payloads("body")[0]).toMatchObject({
    condition: "truncated",
    blob: { encoding: "binary", size: 1_000_000, condition: "truncated" },
  });
  expect(payloads("body")[0]).not.toHaveProperty("body");
});

test("a body the sink cannot store is unavailable with the reason", async () => {
  const { blobs } = sink(() => new Error("disk full"));
  const { channel, handle, payloads } = await page({ blobs });
  channel.replies.set("Network.getResponseBody", { body: "x", base64Encoded: false });
  exchange(channel);
  await handle.settled();
  expect(payloads("body")).toMatchObject([
    { condition: "unavailable", reason: "The body could not be stored: disk full" },
  ]);
});

test("WebSocket frames are recorded both ways, with encoding and truncation flagged", async () => {
  const { channel, handle, of } = await page();
  const ws = "ws://127.0.0.1:4600/ws/echo";
  const long = "A".repeat(MAX_FRAME_PAYLOAD_LENGTH + 4);
  channel.emit("Network.webSocketCreated", { requestId: "W1", url: ws }, "S1");
  channel.emit(
    "Network.webSocketHandshakeResponseReceived",
    {
      requestId: "W1",
      timestamp: 1,
      response: {
        status: 101,
        statusText: "Switching Protocols",
        headers: { Upgrade: "websocket", "Set-Cookie": "ws=s3cr3t" },
      },
    },
    "S1",
  );
  const frame = (method: string, opcode: number, payloadData: string) =>
    channel.emit(
      method,
      { requestId: "W1", timestamp: 2, response: { opcode, mask: false, payloadData } },
      "S1",
    );
  frame("Network.webSocketFrameSent", 1, "ping");
  frame("Network.webSocketFrameReceived", 2, long);
  channel.emit(
    "Network.webSocketFrameError",
    { requestId: "W1", timestamp: 3, errorMessage: "bad frame" },
    "S1",
  );
  channel.emit("Network.webSocketClosed", { requestId: "W1", timestamp: 4 }, "S1");
  await handle.settled();
  expect(of("network").map(({ type, payload }) => ({ type, payload }))).toEqual([
    { type: "websocket-created", payload: { requestId: "W1", url: ws } },
    {
      type: "websocket-handshake",
      payload: {
        requestId: "W1",
        status: 101,
        statusText: "Switching Protocols",
        headers: { Upgrade: "websocket", "Set-Cookie": "redacted" },
      },
    },
    {
      type: "websocket-frame",
      payload: {
        requestId: "W1",
        direction: "sent",
        opcode: 1,
        encoding: "utf8",
        payload: "ping",
        size: 4,
        truncated: false,
      },
    },
    {
      type: "websocket-frame",
      payload: {
        requestId: "W1",
        direction: "received",
        opcode: 2,
        encoding: "base64",
        payload: long.slice(0, MAX_FRAME_PAYLOAD_LENGTH),
        size: long.length,
        truncated: true,
      },
    },
    { type: "websocket-error", payload: { requestId: "W1", errorMessage: "bad frame" } },
    { type: "websocket-closed", payload: { requestId: "W1" } },
  ]);
});

test("malformed WebSocket notifications and unknown Network methods record nothing", async () => {
  const { channel, handle, of } = await page();
  for (const method of [
    "Network.webSocketCreated",
    "Network.webSocketHandshakeResponseReceived",
    "Network.webSocketFrameSent",
    "Network.webSocketClosed",
    "Network.dataReceived",
  ])
    channel.emit(method, { requestId: 7 }, "S1");
  channel.emit("Network.requestServedFromCache", { requestId: "unknown" }, "S1");
  await handle.settled();
  expect(of("network")).toEqual([]);
});
