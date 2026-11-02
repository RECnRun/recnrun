import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

// RFC 6455 handshake constant.
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

interface Frame {
  opcode: number;
  payload: Buffer;
  size: number;
}

function payloadStart(buffer: Buffer): { length: number; offset: number } | null {
  const short = buffer.readUInt8(1) & 0x7f;
  if (short < 126) return { length: short, offset: 2 };
  if (short === 126)
    return buffer.length < 4 ? null : { length: buffer.readUInt16BE(2), offset: 4 };
  return buffer.length < 10 ? null : { length: Number(buffer.readBigUInt64BE(2)), offset: 10 };
}

/** Reads one complete frame from the start of the buffer, or null when more bytes are needed. */
function readFrame(buffer: Buffer): Frame | null {
  if (buffer.length < 2) return null;
  const start = payloadStart(buffer);
  if (start === null) return null;
  const masked = (buffer.readUInt8(1) & 0x80) !== 0;
  const dataOffset = start.offset + (masked ? 4 : 0);
  if (buffer.length < dataOffset + start.length) return null;
  const payload = Buffer.from(buffer.subarray(dataOffset, dataOffset + start.length));
  for (let index = 0; masked && index < payload.length; index++) {
    const mask = buffer.readUInt8(start.offset + (index % 4));
    payload.writeUInt8(payload.readUInt8(index) ^ mask, index);
  }
  return { opcode: buffer.readUInt8(0) & 0x0f, payload, size: dataOffset + start.length };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const first = 0x80 | opcode;
  if (payload.length < 126) return Buffer.concat([Buffer.from([first, payload.length]), payload]);
  const head = Buffer.alloc(payload.length < 0x10000 ? 4 : 10);
  head.writeUInt8(first, 0);
  if (head.length === 4) {
    head.writeUInt8(126, 1);
    head.writeUInt16BE(payload.length, 2);
  } else {
    head.writeUInt8(127, 1);
    head.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([head, payload]);
}

function answer(socket: Duplex, frame: Frame): void {
  if (frame.opcode === OPCODE.text || frame.opcode === OPCODE.binary) {
    socket.write(encodeFrame(frame.opcode, frame.payload));
  } else if (frame.opcode === OPCODE.ping) {
    socket.write(encodeFrame(OPCODE.pong, frame.payload));
  } else if (frame.opcode === OPCODE.close) {
    socket.end(encodeFrame(OPCODE.close, frame.payload));
  }
}

/** Completes the handshake and echoes every text or binary message back unchanged. */
export function acceptEcho(req: IncomingMessage, socket: Duplex): void {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let frame = readFrame(buffer); frame !== null; frame = readFrame(buffer)) {
      buffer = buffer.subarray(frame.size);
      answer(socket, frame);
    }
  });
}
