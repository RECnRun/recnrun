// ECDSA P-256 signatures: WebCrypto's P1363 (r||s, 64 bytes) and openssl's DER SEQUENCE of two INTEGERs.
const HALF = 32;

// An unsigned big-endian integer as a DER INTEGER: no leading zeros, one zero byte if the top bit is set.
const integer = (bytes) => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const body = bytes.subarray(start);
  const padded = body[0] >= 0x80 ? Uint8Array.of(0, ...body) : body;
  return Uint8Array.of(0x02, padded.length, ...padded);
};

export const p1363ToDer = (signature) => {
  if (signature.length !== HALF * 2) throw new Error("P1363 signature must be 64 bytes");
  const r = integer(signature.subarray(0, HALF));
  const s = integer(signature.subarray(HALF));
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
};

// Reads one INTEGER at `at`; answers its value right-aligned in 32 bytes and the next offset.
const readInteger = (der, at) => {
  if (der[at] !== 0x02) throw new Error("DER: INTEGER expected");
  const length = der[at + 1];
  const end = at + 2 + length;
  if (!(length >= 1) || end > der.length) throw new Error("DER: bad INTEGER length");
  let value = der.subarray(at + 2, end);
  while (value.length > 1 && value[0] === 0) value = value.subarray(1);
  if (value.length > HALF) throw new Error("DER: INTEGER too large");
  const out = new Uint8Array(HALF);
  out.set(value, HALF - value.length);
  return { out, next: end };
};

export const derToP1363 = (der) => {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error("DER: SEQUENCE expected");
  const r = readInteger(der, 2);
  const s = readInteger(der, r.next);
  if (s.next !== der.length) throw new Error("DER: trailing bytes");
  return Uint8Array.of(...r.out, ...s.out);
};
