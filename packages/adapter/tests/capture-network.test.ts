import { MAX_INLINE_BODY_LENGTH } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { capturing, type ReplyingChannel } from "./capture-harness.ts";

const API = "http://127.0.0.1:4600/api/json";

function request(channel: ReplyingChannel, requestId: string, extra: Record<string, unknown> = {}) {
  channel.emit(
    "Network.requestWillBeSent",
    { requestId, request: { url: API, method: "GET" }, type: "Fetch", frameId: "T1", ...extra },
    "S1",
  );
}

function respond(channel: ReplyingChannel, requestId: string, status = 200, type = "Fetch") {
  channel.emit(
    "Network.responseReceived",
    {
      requestId,
      type,
      response: { url: API, status, statusText: "OK", mimeType: "application/json" },
    },
    "S1",
  );
}

const finish = (channel: ReplyingChannel, requestId: string) =>
  channel.emit("Network.loadingFinished", { requestId, encodedDataLength: 42 }, "S1");

async function page(options = {}) {
  const harness = await capturing(options);
  harness.channel.attach("S1", { targetId: "T1", type: "page" });
  await harness.handle.settled();
  const bodies = () => harness.of("network", "body").map(({ payload }) => payload);
  return { ...harness, bodies };
}

test("a finished JSON response is followed by its captured body", async () => {
  const { channel, handle, of, bodies } = await page();
  channel.replies.set("Network.getResponseBody", { body: '{"ok":true}', base64Encoded: false });
  request(channel, "R1");
  respond(channel, "R1");
  finish(channel, "R1");
  await handle.settled();
  expect(of("network").map(({ type }) => type)).toEqual([
    "request",
    "response",
    "finished",
    "body",
  ]);
  expect(of("network")).toMatchObject([
    { frameId: "T1", payload: { requestId: "R1", url: API, method: "GET", resourceType: "Fetch" } },
    { frameId: "T1", payload: { status: 200, mimeType: "application/json" } },
    { payload: { encodedDataLength: 42 } },
    { frameId: "T1" },
  ]);
  expect(bodies()).toEqual([
    {
      requestId: "R1",
      url: API,
      mimeType: "application/json",
      condition: "captured",
      size: 11,
      base64Encoded: false,
      body: '{"ok":true}',
    },
  ]);
  expect(channel.sent.at(-1)).toEqual({
    method: "Network.getResponseBody",
    params: { requestId: "R1" },
    sessionId: "S1",
  });
});

test("a long body is truncated with its full size, and an unread body says why", async () => {
  const { channel, handle, bodies } = await page({ maxBodyLength: 4 });
  channel.replies.set("Network.getResponseBody", { body: "abcdefgh", base64Encoded: true });
  request(channel, "R1");
  respond(channel, "R1");
  finish(channel, "R1");
  await handle.settled();
  channel.replies.set("Network.getResponseBody", {});
  request(channel, "R2");
  respond(channel, "R2");
  finish(channel, "R2");
  await handle.settled();
  channel.replies.delete("Network.getResponseBody");
  channel.failing.set("Network.getResponseBody", "No resource with given identifier found");
  request(channel, "R3");
  respond(channel, "R3");
  finish(channel, "R3");
  await handle.settled();
  expect(bodies()).toMatchObject([
    { condition: "truncated", size: 8, base64Encoded: true, body: "abcd" },
    { condition: "unavailable", reason: "Chrome answered without a body." },
    { condition: "unavailable", reason: "No resource with given identifier found" },
  ]);
});

test("images are not requested, and redirect hops build the chain", async () => {
  const { channel, handle, of, bodies } = await page();
  request(channel, "IMG", { type: "Image" });
  respond(channel, "IMG", 200, "Image");
  finish(channel, "IMG");
  const submit = "http://127.0.0.1:4600/api/submit";
  const result = "http://127.0.0.1:4600/routes/submit-result";
  channel.emit(
    "Network.requestWillBeSent",
    { requestId: "D1", request: { url: submit, method: "POST" }, type: "Document", frameId: "T1" },
    "S1",
  );
  channel.emit(
    "Network.requestWillBeSent",
    {
      requestId: "D1",
      request: { url: result, method: "GET" },
      type: "Document",
      frameId: "T1",
      redirectResponse: { url: submit, status: 303 },
    },
    "S1",
  );
  await handle.settled();
  expect(bodies()).toMatchObject([
    {
      requestId: "IMG",
      condition: "not-requested",
      reason: "Bodies of Image resources are not requested.",
    },
  ]);
  expect(of("network", "request").map(({ payload }) => payload)).toEqual([
    expect.objectContaining({ requestId: "IMG" }),
    { requestId: "D1", url: submit, method: "POST", resourceType: "Document" },
    {
      requestId: "D1",
      url: result,
      method: "GET",
      resourceType: "Document",
      redirectChain: [{ url: submit, method: "POST", status: 303 }],
    },
  ]);
});

test("failures record the error, and a body lost mid-load is unavailable", async () => {
  const { channel, of, bodies } = await page();
  request(channel, "R1");
  channel.emit("Network.loadingFailed", { requestId: "R1", errorText: "net::ERR_FAILED" }, "S1");
  request(channel, "R2");
  respond(channel, "R2");
  channel.emit(
    "Network.loadingFailed",
    { requestId: "R2", errorText: "net::ERR_ABORTED", canceled: true, blockedReason: "inspector" },
    "S1",
  );
  channel.emit("Network.loadingFailed", { requestId: "R9", errorText: "x" }, "S1");
  channel.emit("Network.loadingFinished", { requestId: "R9", encodedDataLength: 0 }, "S1");
  for (const method of [
    "requestWillBeSent",
    "responseReceived",
    "loadingFinished",
    "loadingFailed",
    "dataReceived",
  ])
    channel.emit(`Network.${method}`, {}, "S1");
  expect(of("network", "failed").map(({ payload }) => payload)).toEqual([
    { requestId: "R1", errorText: "net::ERR_FAILED", canceled: false },
    { requestId: "R2", errorText: "net::ERR_ABORTED", canceled: true, blockedReason: "inspector" },
    { requestId: "R9", errorText: "x", canceled: false },
  ]);
  expect(bodies()).toEqual([
    expect.objectContaining({
      requestId: "R2",
      condition: "unavailable",
      reason: "Loading failed: net::ERR_ABORTED",
    }),
  ]);
  expect(of("network", "finished")).toMatchObject([{ frameId: null }]);
});

test("a response still loading past the deadline is unavailable, once", async () => {
  const { channel, handle, bodies } = await page({ bodyTimeoutMs: 5 });
  request(channel, "R1");
  respond(channel, "R1");
  await new Promise((resolve) => setTimeout(resolve, 20));
  finish(channel, "R1");
  await handle.settled();
  expect(bodies()).toEqual([
    expect.objectContaining({
      condition: "unavailable",
      reason: "The response was still loading after 5 ms.",
    }),
  ]);
  expect(channel.methods("S1")).not.toContain("Network.getResponseBody");
});

test("a response without its request, and stop or detach while loading, settle every body", async () => {
  const { channel, handle, bodies } = await page();
  respond(channel, "R1");
  respond(channel, "IMG", 200, "Image");
  channel.attach("S2", { targetId: "T2", type: "iframe" });
  channel.emit(
    "Network.requestWillBeSent",
    { requestId: "R5", request: { url: API, method: "GET" }, type: "XHR" },
    "S2",
  );
  channel.emit(
    "Network.responseReceived",
    { requestId: "R5", response: { url: API, status: 200, statusText: "", mimeType: "" } },
    "S2",
  );
  channel.emit("Target.detachedFromTarget", { sessionId: "S2" });
  handle.stop();
  expect(bodies()).toMatchObject([
    {
      requestId: "R5",
      condition: "unavailable",
      reason: "The target went away before the response finished loading.",
    },
    {
      requestId: "R1",
      condition: "unavailable",
      reason: "Capture stopped before the response finished loading.",
    },
    { requestId: "IMG", condition: "not-requested" },
  ]);
  expect(channel.closed).toBe(true);
  await handle.settled();
});

// Fails instead of hanging when `settled()` never resolves.
const within = (work: Promise<void>, ms: number) =>
  Promise.race([
    work,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`settled() did not resolve within ${ms} ms`)), ms),
    ),
  ]);

test("a body read Chrome never answers is unavailable at the deadline, once", async () => {
  const { channel, handle, bodies } = await page({ bodyTimeoutMs: 20 });
  channel.holding.add("Network.getResponseBody");
  request(channel, "R1");
  respond(channel, "R1");
  finish(channel, "R1");
  await within(handle.settled(), 1_000);
  expect(bodies()).toEqual([
    expect.objectContaining({
      requestId: "R1",
      condition: "unavailable",
      reason: "Chrome did not return the body within 20 ms.",
    }),
  ]);
  channel.held[0]?.({ body: "late", base64Encoded: false });
  await within(handle.settled(), 1_000);
  expect(bodies()).toHaveLength(1);
});

test("detach and stop settle a body read Chrome has not answered", async () => {
  const { channel, handle, bodies } = await page();
  channel.holding.add("Network.getResponseBody");
  channel.attach("S2", { targetId: "T2", type: "iframe" });
  for (const [sessionId, requestId] of [
    ["S1", "R1"],
    ["S2", "R2"],
  ] as const) {
    channel.emit(
      "Network.requestWillBeSent",
      { requestId, request: { url: API, method: "GET" }, type: "Fetch" },
      sessionId,
    );
    channel.emit(
      "Network.responseReceived",
      { requestId, response: { url: API, status: 200, statusText: "", mimeType: "" } },
      sessionId,
    );
    channel.emit("Network.loadingFinished", { requestId, encodedDataLength: 1 }, sessionId);
  }
  channel.emit("Target.detachedFromTarget", { sessionId: "S2" });
  handle.stop();
  await within(handle.settled(), 1_000);
  for (const resolve of channel.held) resolve({ body: "late", base64Encoded: false });
  await within(handle.settled(), 1_000);
  expect(bodies()).toMatchObject([
    { requestId: "R2", condition: "unavailable", reason: expect.stringMatching(/went away/) },
    { requestId: "R1", condition: "unavailable", reason: expect.stringMatching(/stopped/) },
  ]);
});

test("a maxBodyLength above the inline limit is clamped, so a long body is truncated", async () => {
  const { channel, handle, bodies } = await page({ maxBodyLength: 100_000 });
  channel.replies.set("Network.getResponseBody", {
    body: "x".repeat(70_000),
    base64Encoded: false,
  });
  request(channel, "R1");
  respond(channel, "R1");
  finish(channel, "R1");
  await handle.settled();
  expect(bodies()).toMatchObject([
    { condition: "truncated", size: 70_000, body: "x".repeat(MAX_INLINE_BODY_LENGTH) },
  ]);
});
