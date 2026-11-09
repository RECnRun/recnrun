// The launcher's policy.json, falling back to the lab's storage provision when the file is absent.
import { isWebOrigin } from "./allow.js";

const KEYS = "allow,generation,interactEnabled,masterSpki,root,v,viewport,workspace";
const VIEWPORT_KEYS = "maxHeight,maxWidth,minHeight,minWidth";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const P256_PREFIX = "3059301306072a8648ce3d020106082a8648ce3d030107034200";
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keysAre = (value, keys) => isObject(value) && Object.keys(value).sort().join(",") === keys;
const isCount = (value) => Number.isSafeInteger(value) && value >= 1;

export const spkiBytes = (base64) => {
  try {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
};

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const isP256Spki = (base64) => {
  const bytes = spkiBytes(base64);
  return bytes.length === 91 && hex(bytes.subarray(0, 26)) === P256_PREFIX;
};

const allowValid = (allow) =>
  Array.isArray(allow) &&
  allow.length >= 1 &&
  ((allow.length === 1 && allow[0] === "*") || allow.every(isWebOrigin));

const viewportValid = (viewport) =>
  keysAre(viewport, VIEWPORT_KEYS) &&
  Object.values(viewport).every(isCount) &&
  viewport.minWidth <= viewport.maxWidth &&
  viewport.minHeight <= viewport.maxHeight;

const policyValid = (policy) =>
  keysAre(policy, KEYS) &&
  policy.v === 1 &&
  UUID.test(policy.workspace) &&
  /^w[1-9]$/.test(policy.root) &&
  isCount(policy.generation) &&
  isP256Spki(policy.masterSpki) &&
  allowValid(policy.allow) &&
  typeof policy.interactEnabled === "boolean" &&
  viewportValid(policy.viewport);

export const parsePolicy = (bytes) => {
  let policy;
  try {
    policy = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("BAD_POLICY: not JSON");
  }
  if (!policyValid(policy)) throw new Error("BAD_POLICY: invalid fields");
  return policy;
};

// The gates verify with a JWK, so the policy's SPKI is re-expressed once as one.
const provisionOf = async (policy) => {
  const key = await crypto.subtle.importKey("spki", spkiBytes(policy.masterSpki), ECDSA, true, [
    "verify",
  ]);
  return {
    masterKey: await crypto.subtle.exportKey("jwk", key),
    allowlist: policy.allow,
    interactEnabled: policy.interactEnabled,
    viewport: policy.viewport,
    generation: policy.generation,
    source: "policy",
  };
};

const load = async (readPolicy) => {
  const bytes = await readPolicy();
  if (!bytes) return null;
  try {
    const policy = parsePolicy(bytes);
    return { policy, bytes, provision: await provisionOf(policy) };
  } catch (error) {
    console.warn(`[worker] policy refused: ${String(error)}`);
    return { policy: null, bytes, provision: undefined };
  }
};

export const createProvision = ({ readPolicy, readStorage }) => {
  let filed;
  const file = () => (filed ??= load(readPolicy));
  return {
    current: async () => {
      const found = await file();
      return found ? found.provision : readStorage();
    },
    filed: async () => {
      const found = await file();
      return found?.policy ? { policy: found.policy, bytes: found.bytes } : null;
    },
  };
};
