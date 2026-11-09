// Keys of the owner page: fingerprints, signed requests and offers, and answer verification.
import { p1363ToDer } from "./der.js";
import { canonical } from "./jobs.js";

const ECDSA = { name: "ECDSA", hash: "SHA-256" };
const PREFIX = [
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encode = (text) => new TextEncoder().encode(text);

export const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
export const toBase64Url = (bytes) =>
  toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
export const fromBase64Url = (text) => {
  const standard = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

export const spkiOk = (bytes) =>
  bytes.length === 91 && PREFIX.every((value, index) => bytes[index] === value);

export const sha256Hex = async (bytes) => {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
export const fingerprint = sha256Hex;

export const spkiToJwk = async (spki) => {
  const key = await crypto.subtle.importKey(
    "spki",
    spki,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  return crypto.subtle.exportKey("jwk", key);
};

const GRAMMAR = {
  workspace: UUID,
  session: /^[0-9a-f]{16}$/,
  request: UUID,
  root: /^w[0-9]$/,
  offer: HEX,
  attempt: UUID,
};
const ORDER = ["workspace", "session", "request", "action", "root", "offer", "attempt", "expires"];

export const buildRequest = async (fields, key) => {
  for (const [name, pattern] of Object.entries(GRAMMAR)) {
    if (!pattern.test(fields[name])) throw new Error(`bad request field ${name}`);
  }
  if (!Number.isInteger(fields.expires)) throw new Error("bad request field expires");
  const values = { ...fields, action: "start" };
  const body = `recnrun-lab-request v1\n${ORDER.map((name) => `${name}=${values[name]}`).join("\n")}\n`;
  const signature = new Uint8Array(await crypto.subtle.sign(ECDSA, key, encode(body)));
  const text = `${body}sig=${toBase64(p1363ToDer(signature))}\n`;
  if (text.length > 1024) throw new Error("request too large");
  return text;
};

export const signOffer = async (fields, key) => {
  const signature = await crypto.subtle.sign(ECDSA, key, encode(canonical(fields)));
  return { ...fields, signature: toBase64Url(new Uint8Array(signature)) };
};

const refuse = (reason) => ({ ok: false, reason });

const mismatch = (answer, expected) => {
  if (answer.root !== expected.root) return "wrong-root";
  if (answer.attempt !== expected.attempt) return "wrong-attempt";
  if (answer.nonce !== expected.nonce) return "wrong-nonce";
  return null;
};

const pinned = (answer, pinnedSpki) => {
  try {
    const sent = Uint8Array.from(atob(answer.workerSpki), (char) => char.charCodeAt(0));
    return (
      sent.length === pinnedSpki.length && sent.every((byte, index) => byte === pinnedSpki[index])
    );
  } catch {
    return false;
  }
};

export const verifyAnswer = async (answer, pinnedSpki, expected) => {
  const shaped =
    answer?.type === "answer" &&
    typeof answer.signature === "string" &&
    typeof answer.workerSpki === "string";
  if (!shaped) return refuse("malformed");
  const wrong = mismatch(answer, expected);
  if (wrong) return refuse(wrong);
  if (!pinned(answer, pinnedSpki)) return refuse("worker-key-mismatch");
  const { signature, ...body } = answer;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      pinnedSpki,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const good = await crypto.subtle.verify(
      ECDSA,
      key,
      fromBase64Url(signature),
      encode(canonical(body)),
    );
    return good ? { ok: true } : refuse("bad-signature");
  } catch {
    return refuse("bad-signature");
  }
};
