import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

// RFC 6455 §1.3: the server proves it read the key by hashing it with this GUID.
const KEY_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A text message larger than this closes the socket with 1009. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Close codes the service sends; 4401 is the application's "no valid token". */
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupported: 1003,
  invalidText: 1007,
  tooBig: 1009,
  unauthorized: 4401,
} as const;

const OPCODE = { text: 0x1, close: 0x8, ping: 0x9, pong: 0xa } as const;

interface FrameHeader {
  fin: boolean;
  opcode: number;
  masked: boolean;
  length: number;
  /** Where the payload starts; the 4-byte mask sits just before it. */
  start: number;
}

/** One accepted WebSocket: text messages in, text messages out. */
export interface WebSocketChannel {
  /** Starts reading frames, `head` first; until then nothing the client sent is handled. */
  start(head: Buffer, onText: (text: string) => void): void;
  send(text: string): void;
  close(code: number, reason?: string): void;
  /** Runs once the socket is gone, whichever side closed it. */
  onClose(listener: () => void): void;
  readonly closed: boolean;
}

function readHeader(buffer: Buffer): FrameHeader | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer.readUInt8(0);
  const second = buffer.readUInt8(1);
  const short = second & 0x7f;
  const extended = short === 126 ? 2 : short === 127 ? 8 : 0;
  if (buffer.length < 2 + extended) return undefined;
  let length = short;
  if (short === 126) length = buffer.readUInt16BE(2);
  if (short === 127) length = Number(buffer.readBigUInt64BE(2));
  const masked = (second & 0x80) !== 0;
  const fin = (first & 0x80) !== 0;
  return { fin, opcode: first & 0x0f, masked, length, start: 2 + extended + (masked ? 4 : 0) };
}

/** The close code a frame header earns before its payload is read, if any. */
function violation({ fin, opcode, masked, length }: FrameHeader): number | undefined {
  if (!masked) return CLOSE.protocolError;
  const control = opcode >= OPCODE.close;
  if (control && (length > 125 || !fin)) return CLOSE.protocolError;
  // Fragmented and binary messages are not part of the API.
  if (!control && (!fin || opcode !== OPCODE.text)) return CLOSE.unsupported;
  return length > MAX_MESSAGE_BYTES ? CLOSE.tooBig : undefined;
}

function unmask(buffer: Buffer, { start, length }: FrameHeader): Buffer {
  const payload = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1)
    payload[index] = buffer.readUInt8(start + index) ^ buffer.readUInt8(start - 4 + (index % 4));
  return payload;
}

function encode(opcode: number, payload: Buffer): Buffer {
  const { length } = payload;
  const size = length < 126 ? 2 : length < 65_536 ? 4 : 10;
  const header = Buffer.alloc(size);
  header.writeUInt8(0x80 | opcode, 0);
  if (size === 2) header.writeUInt8(length, 1);
  if (size === 4) {
    header.writeUInt8(126, 1);
    header.writeUInt16BE(length, 2);
  }
  if (size === 10) {
    header.writeUInt8(127, 1);
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

type Taken = { opcode: number; payload: Buffer; rest: Buffer } | { refused: number };

/** The next complete frame of `pending`, the close code that refuses it, or undefined until more bytes arrive. */
function takeFrame(pending: Buffer): Taken | undefined {
  const header = readHeader(pending);
  if (header === undefined) return undefined;
  const refused = violation(header);
  if (refused !== undefined) return { refused };
  const end = header.start + header.length;
  if (pending.length < end) return undefined;
  return { opcode: header.opcode, payload: unmask(pending, header), rest: pending.subarray(end) };
}

/** A text frame's payload, or undefined when it is not valid UTF-8. */
function decodeText(payload: Buffer): string | undefined {
  try {
    return strictUtf8.decode(payload);
  } catch {
    return undefined;
  }
}

function closePayload(code: number, reason: string): Buffer {
  const body = Buffer.alloc(2);
  body.writeUInt16BE(code);
  return Buffer.concat([body, Buffer.from(reason)]);
}

function createChannel(socket: Duplex): WebSocketChannel {
  let pending: Buffer = Buffer.alloc(0);
  let closed = false;
  let listener: (text: string) => void = () => {};
  socket.on("close", () => (closed = true));
  const write = (opcode: number, payload: Buffer) => {
    if (!closed) socket.write(encode(opcode, payload));
  };
  const close = (code: number, reason = "") => {
    if (closed) return;
    write(OPCODE.close, closePayload(code, reason));
    closed = true;
    socket.end();
    // A client that never answers the close must not keep the server from stopping.
    setTimeout(() => socket.destroy(), 1000).unref();
  };
  const handle = (opcode: number, payload: Buffer) => {
    if (opcode === OPCODE.ping) write(OPCODE.pong, payload);
    if (opcode === OPCODE.close)
      close(payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.normal);
    if (opcode !== OPCODE.text) return;
    const text = decodeText(payload);
    if (text === undefined) close(CLOSE.invalidText);
    else listener(text);
  };
  const consume = () => {
    for (let next = takeFrame(pending); next && !closed; next = takeFrame(pending)) {
      if ("refused" in next) return close(next.refused);
      pending = next.rest;
      handle(next.opcode, next.payload);
    }
  };
  return {
    start(head, onText) {
      listener = onText;
      pending = Buffer.from(head);
      socket.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        consume();
      });
      consume();
    },
    send: (text) => write(OPCODE.text, Buffer.from(text)),
    close,
    onClose: (notify) => void (socket.destroyed ? notify() : socket.once("close", notify)),
    get closed() {
      return closed;
    },
  };
}

/** Answers an upgrade that is not accepted with a plain HTTP status, then closes the socket. */
export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Completes the RFC 6455 handshake; a request without a version 13 key gets 400. */
export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
): WebSocketChannel | undefined {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string" || request.headers["sec-websocket-version"] !== "13") {
    refuseUpgrade(socket, 400, "Bad Request");
    return undefined;
  }
  const accept = createHash("sha1").update(`${key}${KEY_GUID}`).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return createChannel(socket);
}
