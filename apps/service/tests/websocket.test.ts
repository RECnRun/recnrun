import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { expect, test } from "vite-plus/test";
import { acceptWebSocket, CLOSE, MAX_MESSAGE_BYTES } from "@/websocket";

const MASK = Buffer.from([1, 2, 3, 4]);

/** A client frame: masked unless told otherwise. */
function clientFrame(opcode: number, payload: Buffer, { fin = true, masked = true } = {}): Buffer {
  const length = payload.length;
  const lengthBytes =
    length < 126
      ? Buffer.from([length | (masked ? 0x80 : 0)])
      : Buffer.from([126 | (masked ? 0x80 : 0), length >> 8, length & 0xff]);
  const body = Buffer.from(
    payload.map((byte, index) => (masked ? byte ^ (MASK[index % 4] ?? 0) : byte)),
  );
  return Buffer.concat([
    Buffer.from([(fin ? 0x80 : 0) | opcode]),
    lengthBytes,
    masked ? MASK : Buffer.alloc(0),
    body,
  ]);
}

function open() {
  const socket = new PassThrough();
  const written: Buffer[] = [];
  socket.write = ((chunk: Buffer) => written.push(Buffer.from(chunk)) > 0) as typeof socket.write;
  const request = {
    headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" },
  } as unknown as IncomingMessage;
  const channel = acceptWebSocket(request, socket);
  const received: string[] = [];
  channel?.start(Buffer.alloc(0), (text) => received.push(text));
  const closeCode = () => {
    const frame = written.findLast((chunk) => chunk[0] === 0x88);
    return frame?.readUInt16BE(2);
  };
  return { socket, written, channel, received, closeCode };
}

test("answers the RFC 6455 handshake with the expected accept key", () => {
  const { written } = open();
  expect(written[0]?.toString()).toContain("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("delivers masked text, even split across chunks, and frames replies", () => {
  const { socket, channel, received, written } = open();
  const frame = clientFrame(0x1, Buffer.from("héllo"));
  socket.emit("data", frame.subarray(0, 3));
  socket.emit("data", frame.subarray(3));
  expect(received).toEqual(["héllo"]);
  channel?.send("x".repeat(200));
  expect(written.at(-1)?.subarray(0, 4)).toEqual(Buffer.from([0x81, 126, 0, 200]));
});

test("answers ping with pong and a close with the same code", () => {
  const { socket, written, closeCode, channel } = open();
  socket.emit("data", clientFrame(0x9, Buffer.from("p")));
  expect(written.at(-1)).toEqual(Buffer.from([0x8a, 1, 0x70]));
  socket.emit("data", clientFrame(0x8, Buffer.from([0x03, 0xe8])));
  expect(closeCode()).toBe(1000);
  expect(channel?.closed).toBe(true);
});

test.each([
  ["an unmasked frame", clientFrame(0x1, Buffer.from("a"), { masked: false }), CLOSE.protocolError],
  ["a fragment", clientFrame(0x1, Buffer.from("a"), { fin: false }), CLOSE.unsupported],
  ["a binary frame", clientFrame(0x2, Buffer.from("a")), CLOSE.unsupported],
  ["text that is not UTF-8", clientFrame(0x1, Buffer.from([0xff, 0xfe])), CLOSE.invalidText],
  ["a message over the limit", Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0x20, 0, 0]), CLOSE.tooBig],
])("closes on %s", (_name, frame, code) => {
  const { socket, received, closeCode } = open();
  socket.emit("data", frame);
  expect(closeCode()).toBe(code);
  expect(received).toEqual([]);
  expect(MAX_MESSAGE_BYTES).toBeLessThan(0x20_0000);
});

test("refuses an upgrade without a version 13 key", () => {
  const socket = new PassThrough();
  const request = { headers: { "sec-websocket-version": "8" } } as unknown as IncomingMessage;
  expect(acceptWebSocket(request, socket)).toBeUndefined();
  expect(String(socket.read())).toMatch(/^HTTP\/1\.1 400 Bad Request/);
});
