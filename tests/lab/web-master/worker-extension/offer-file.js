// The launcher-bridged offer and the worker's signed answer (owner flow shared contracts).
import { canonical } from "./encoding.js";
import { signatureValid } from "./job-check.js";

const OFFER_KEYS = "attempt,expiresAt,issuedAt,nonce,root,sdp,signature,type,v,workspace";
const ATTEMPT = /^[A-Za-z0-9-]{1,64}$/;
const CLOCK_SKEW_MS = 30_000;
const MAX_SEEN = 64;
const SIGN = { name: "ECDSA", hash: "SHA-256" };

const fromUrl = (text) => text.replaceAll("-", "+").replaceAll("_", "/");
const toUrl = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export const isAttempt = (value) => typeof value === "string" && ATTEMPT.test(value);
export const offerFileOf = (attempt) => `offer-${attempt}.json`;

const isText = (value) => typeof value === "string" && value.length > 0;
const shapeValid = (offer) =>
  Boolean(offer) &&
  typeof offer === "object" &&
  Object.keys(offer).sort().join(",") === OFFER_KEYS &&
  offer.v === 1 &&
  offer.type === "offer" &&
  isAttempt(offer.attempt) &&
  [offer.nonce, offer.sdp, offer.signature].every(isText) &&
  [offer.issuedAt, offer.expiresAt].every(Number.isSafeInteger);

const clockError = (offer, at) => {
  if (offer.issuedAt > at + CLOCK_SKEW_MS || offer.expiresAt <= at) return "EXPIRED";
  return null;
};

/** Null when the offer may be answered, otherwise why not; a nonce is answered once. */
export const createOfferCheck = ({ now = Date.now } = {}) => {
  const seen = [];
  return async (offer, { workspace, root, masterKey }) => {
    if (!shapeValid(offer)) return "BAD_FORMAT";
    if (offer.root !== root) return "WRONG_ROOT";
    if (offer.workspace !== workspace) return "WRONG_WORKSPACE";
    const late = clockError(offer, now());
    if (late) return late;
    if (seen.includes(offer.nonce)) return "SEEN";
    const signed = { ...offer, signature: fromUrl(offer.signature) };
    if (!(await signatureValid(signed, masterKey))) return "BAD_SIGNATURE";
    seen.push(offer.nonce);
    if (seen.length > MAX_SEEN) seen.shift();
    return null;
  };
};

export const signAnswer = async ({ offer, bootId, sdp, identity }) => {
  const fields = {
    v: 1,
    type: "answer",
    root: offer.root,
    attempt: offer.attempt,
    nonce: offer.nonce,
    bootId,
    sdp,
    workerSpki: identity.spki,
  };
  const data = new TextEncoder().encode(canonical(fields));
  return { ...fields, signature: toUrl(await crypto.subtle.sign(SIGN, identity.privateKey, data)) };
};
