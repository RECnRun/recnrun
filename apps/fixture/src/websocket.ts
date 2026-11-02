import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

// RFC 6455 handshake GUID; the echo needs no library for unfragmented frames.
const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const CLOSE = 0x8;
const PING = 0x9;
const PONG = 0xa;
const MAX_BUFFERED = 2 * 1024 * 1024;

interface Frame {
  opcode: number;
  payload: Buffer;
  size: number;
}

function payloadStart(buffer: Buffer): { length: number; offset: number } | undefined {
  const length = buffer.readUInt8(1) & 0x7f;
  if (length < 126) return { length, offset: 2 };
  if (length === 126)
    return buffer.length < 4 ? undefined : { length: buffer.readUInt16BE(2), offset: 4 };
  return buffer.length < 10 ? undefined : { length: Number(buffer.readBigUInt64BE(2)), offset: 10 };
}

function parseFrame(buffer: Buffer): Frame | undefined {
  const start = buffer.length < 2 ? undefined : payloadStart(buffer);
  if (!start) return undefined;
  const masked = (buffer.readUInt8(1) & 0x80) !== 0;
  const offset = start.offset + (masked ? 4 : 0);
  const size = offset + start.length;
  if (buffer.length < size) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, size));
  for (let index = 0; masked && index < payload.length; index += 1) {
    const mask = buffer.readUInt8(start.offset + (index % 4));
    payload.writeUInt8(payload.readUInt8(index) ^ mask, index);
  }
  return { opcode: buffer.readUInt8(0) & 0x0f, payload, size };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const { length } = payload;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0, length]);
  } else if (length < 65_536) {
    header = Buffer.from([0, 126, 0, 0]);
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.from([0, 127, 0, 0, 0, 0, 0, 0, 0, 0]);
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header.writeUInt8(0x80 | opcode, 0);
  return Buffer.concat([header, payload]);
}

/** Answers every complete frame and returns the bytes of the incomplete one. */
function answer(socket: Duplex, received: Buffer): Buffer {
  let buffer = received;
  for (let frame = parseFrame(buffer); frame; frame = parseFrame(buffer)) {
    buffer = buffer.subarray(frame.size);
    if (frame.opcode === CLOSE) {
      socket.end(encodeFrame(CLOSE, frame.payload));
      return Buffer.alloc(0);
    }
    socket.write(encodeFrame(frame.opcode === PING ? PONG : frame.opcode, frame.payload));
  }
  if (buffer.length > MAX_BUFFERED) socket.destroy();
  return buffer;
}

/** Upgrades `/ws/echo` to a WebSocket that sends every message back; refuses other paths. */
export function acceptEcho(request: IncomingMessage, socket: Duplex, head: Buffer): void {
  socket.on("error", () => socket.destroy());
  const key = request.headers["sec-websocket-key"];
  if (request.url !== "/ws/echo" || typeof key !== "string") {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(`${key}${HANDSHAKE_GUID}`).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let pending = answer(socket, head);
  socket.on("data", (chunk: Buffer) => {
    pending = answer(socket, Buffer.concat([pending, chunk]));
  });
}
