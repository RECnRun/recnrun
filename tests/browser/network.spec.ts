import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { openBlobStore, type BlobStore } from "../../packages/persistence/src/index.ts";
import { MAX_FRAME_PAYLOAD_LENGTH, type CapturedEvent } from "../../packages/protocol/src/index.ts";
import { expect, payloadOf, requestsTo, test as base, type Captured } from "./fixtures/capture.ts";
import { FIXTURE_ORIGIN, networkResult } from "./fixtures/fixture-app.ts";

// Small enough that the fixture's 200,000-byte body is cut, large enough for every JSON answer.
const BLOB_CAP = 16_384;
const LARGE_BYTES = 200_000;
const LONG_FRAME_LENGTH = 5_000;

const test = base.extend<{ store: BlobStore }>({
  store: async ({ chrome }, use, testInfo) => {
    void chrome;
    await use(await openBlobStore({ folder: testInfo.outputPath("blobs"), maxBytes: BLOB_CAP }));
  },
  captureExtras: async ({ store }, use) => {
    await use({ blobs: store, redactHeaders: ["X-Fixture-Token"] });
  },
});

/** Header names as lowercase, since HTTP/1.1 keeps whatever case the server or page wrote. */
const lower = (headers: unknown): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(headers as Record<string, unknown>).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );

/** The stored bytes a `body` event refers to. */
const blobOf = (store: BlobStore, body: Record<string, unknown> | undefined) =>
  store.read(String((body?.blob as { sha256?: string } | undefined)?.sha256));

/** The events of the one request to `path`, once its body or its failure was recorded. */
async function settled(captured: Captured, path: string, last = "body"): Promise<CapturedEvent[]> {
  const group = () => requestsTo(captured.events, path)[0] ?? [];
  await expect
    .poll(() => group().some((event) => event.type === last), { timeout: 15_000 })
    .toBe(true);
  return group();
}

test("a body above the cap is stored truncated, with its original size", async ({
  app,
  captured,
  store,
}) => {
  const page = await app.open("network");
  expect(await networkResult(page, "large")).toBe(`${LARGE_BYTES} bytes`);
  const body = payloadOf(await settled(captured, "/api/large"), "body");
  expect(body).toMatchObject({
    condition: "truncated",
    blob: { mime: "text/plain", encoding: "utf8", size: LARGE_BYTES, condition: "truncated" },
  });
  expect(body).not.toHaveProperty("body");
  const stored = await blobOf(store, body);
  expect(stored.length).toBe(BLOB_CAP);
  expect(stored.toString("utf8")).toBe("0123456789abcdef".repeat(BLOB_CAP / 16));
});

test("authorization and a session-marked header are redacted everywhere they are stored", async ({
  app,
  captured,
  store,
}, testInfo) => {
  const page = await app.open("network");
  expect(await networkResult(page, "secret")).toBe("authorized");
  const secret = await settled(captured, "/api/secret");
  expect(lower(payloadOf(secret, "request")?.headers)).toMatchObject({
    authorization: "redacted",
  });
  expect(lower(payloadOf(secret, "response")?.headers)).toMatchObject({
    "x-fixture-token": "redacted",
    "content-type": "application/json; charset=utf-8",
  });
  const body = payloadOf(secret, "body");
  expect(body).toMatchObject({ condition: "captured", blob: { mime: "application/json" } });
  const blob = await blobOf(store, body);
  expect(JSON.parse(blob.toString("utf8"))).toEqual({ ok: true, authorized: true });
  await captured.finish();
  const journal = await readFile(testInfo.outputPath("events.jsonl"), "utf8");
  expect(journal).toContain("redacted");
  const files = await readdir(store.folder);
  const blobs = await Promise.all(files.map((name) => readFile(join(store.folder, name), "utf8")));
  for (const text of [journal, ...blobs]) expect(text).not.toContain("s3cr3t");
});

test("a response records its timing and cache state, and a dropped connection fails", async ({
  app,
  captured,
}) => {
  const page = await app.open("network");
  expect(await networkResult(page, "cached")).toBe("cached answer");
  const first = payloadOf(await settled(captured, "/api/cached"), "response");
  expect(first).toMatchObject({ cache: "network", timing: { requestTime: expect.any(Number) } });
  expect(first).not.toHaveProperty("fromCache");
  captured.events.length = 0;
  expect(await networkResult(page, "cached")).toBe("cached answer");
  const again = payloadOf(await settled(captured, "/api/cached"), "response");
  expect(again).toMatchObject({ fromCache: true, cache: expect.stringMatching(/^(disk|memory)$/) });
  expect(await networkResult(page, "abort")).toMatch(/^failed: TypeError/);
  const dropped = await settled(captured, "/api/abort", "failed");
  expect(payloadOf(dropped, "failed")).toMatchObject({
    errorText: expect.stringMatching(/^net::ERR_/),
    canceled: false,
  });
});

test("WebSocket frames are recorded both ways, with their encoding and truncation", async ({
  app,
  captured,
}) => {
  const page = await app.open("network");
  expect(await networkResult(page, "frames")).toBe("3 frames echoed");
  const socket = () =>
    captured.events.filter(
      (event) => event.category === "network" && event.type.startsWith("websocket-"),
    );
  await expect.poll(() => socket().some((event) => event.type === "websocket-closed")).toBe(true);
  expect(payloadOf(socket(), "websocket-created")).toMatchObject({
    url: `${FIXTURE_ORIGIN.replace(/^http/, "ws")}/ws/echo`,
  });
  expect(payloadOf(socket(), "websocket-handshake")).toMatchObject({
    status: 101,
  });
  expect(lower(payloadOf(socket(), "websocket-handshake")?.headers)).toMatchObject({
    upgrade: "websocket",
  });
  const frames = socket()
    .filter((event) => event.type === "websocket-frame")
    .map(({ payload }) => payload);
  const long = "x".repeat(LONG_FRAME_LENGTH);
  for (const direction of ["sent", "received"])
    expect(frames.filter((frame) => frame.direction === direction)).toEqual([
      expect.objectContaining({ opcode: 1, encoding: "utf8", payload: "hello fixture" }),
      expect.objectContaining({ opcode: 2, encoding: "base64", payload: "AQID", truncated: false }),
      expect.objectContaining({
        opcode: 1,
        payload: long.slice(0, MAX_FRAME_PAYLOAD_LENGTH),
        size: LONG_FRAME_LENGTH,
        truncated: true,
      }),
    ]);
});

test("server-sent events are recorded with their name, id, and truncation", async ({
  app,
  captured,
}) => {
  const page = await app.open("network");
  expect(await networkResult(page, "events")).toBe("3 events");
  const messages = () =>
    captured.events
      .filter((event) => event.category === "network" && event.type === "eventsource-message")
      .map(({ payload }) => payload);
  await expect.poll(() => messages().length).toBe(3);
  const long = "y".repeat(LONG_FRAME_LENGTH);
  expect(messages()).toEqual([
    expect.objectContaining({ eventName: "message", data: "hello fixture", truncated: false }),
    expect.objectContaining({ eventName: "tick", eventId: "7", data: "tock", truncated: false }),
    expect.objectContaining({
      eventName: "message",
      data: long.slice(0, MAX_FRAME_PAYLOAD_LENGTH),
      size: LONG_FRAME_LENGTH,
      truncated: true,
    }),
  ]);
});
