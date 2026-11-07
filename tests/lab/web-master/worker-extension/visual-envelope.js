// W6 slice B: the closed binary envelope of visual.v1, version 1 (layout mirrored in site/visual-receiver.js).
const VERSION = 1;
const CODEC_JPEG = 1;
export const HEADER_BYTES = 90;
export const MESSAGE_MAX = 16_384;

const hexBytes = (hex, into, offset) => {
  for (let index = 0; index < 16; index += 1) {
    into[offset + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
};

const uuid = (text, into, offset) => {
  const hex = String(text).replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`NOT_A_UUID: ${text}`);
  hexBytes(hex, into, offset);
};

// An extension id is 32 letters a–p, one per nibble of a 128-bit hash.
const extensionId = (text, into, offset) => {
  if (!/^[a-p]{32}$/.test(text)) throw new Error(`NOT_AN_EXTENSION_ID: ${text}`);
  const hex = [...text].map((letter) => (letter.charCodeAt(0) - 97).toString(16)).join("");
  hexBytes(hex, into, offset);
};

const header = (meta, chunkIndex, chunkCount, frameBytes) => {
  const buffer = new ArrayBuffer(HEADER_BYTES);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  view.setUint8(0, VERSION);
  view.setUint8(1, CODEC_JPEG);
  extensionId(meta.workerId, bytes, 2);
  uuid(meta.bootId, bytes, 18);
  uuid(meta.jobId, bytes, 34);
  view.setUint32(50, meta.targetId);
  view.setUint32(54, meta.epoch);
  view.setUint32(58, meta.frameSeq);
  view.setUint16(62, chunkIndex);
  view.setUint16(64, chunkCount);
  view.setUint32(66, frameBytes);
  view.setUint16(70, meta.width);
  view.setUint16(72, meta.height);
  view.setFloat64(74, meta.capturedAtMs);
  // The master shows a frame only for the observe session it was sent in.
  view.setFloat64(82, meta.sessionEpoch);
  return bytes;
};

/** One frame as messages of at most `messageMax` bytes each, header included. */
export const encodeFrame = (meta, bytes, messageMax = MESSAGE_MAX) => {
  const room = Math.min(messageMax, MESSAGE_MAX) - HEADER_BYTES;
  if (room <= 0) throw new Error("MESSAGE_MAX_TOO_SMALL");
  const chunkCount = Math.max(1, Math.ceil(bytes.length / room));
  const messages = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const payload = bytes.subarray(chunkIndex * room, (chunkIndex + 1) * room);
    const message = new Uint8Array(HEADER_BYTES + payload.length);
    message.set(header(meta, chunkIndex, chunkCount, bytes.length));
    message.set(payload, HEADER_BYTES);
    messages.push(message.buffer);
  }
  return messages;
};
