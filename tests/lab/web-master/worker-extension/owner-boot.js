// Service-worker side of the owner flow: the signal and self-test files, and the file signal start.
import { bootId } from "./capture.js";
import { provision } from "./provision.js";

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
};
const hexDigest = async (bytes) => {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

// The launcher seeded the default download folder as roots/<root>/downloads.
export const writeSignal = (name, body) =>
  chrome.downloads.download({
    url: `data:application/json;base64,${toBase64(JSON.stringify(body))}`,
    filename: name,
    conflictAction: "overwrite",
  });

const NAMES = /^(answer-[A-Za-z0-9-]{1,64}\.json|state\.json)$/;
export const ownerMessages = {
  boot: async () => ({ bootId: bootId() }),
  "signal-file": async ({ name, body }) =>
    NAMES.test(name) ? { ok: Boolean(await writeSignal(name, body)) } : { ok: false },
};

let tested = false;

/** With a policy.json, starts the file signal and writes the self-test once per worker life. */
export const startOwner = async (ask) => {
  const filed = await provision.filed();
  const current = await provision.current();
  if (!filed || !current) return;
  const { policy, bytes } = filed;
  const context = { workspace: policy.workspace, root: policy.root, masterKey: current.masterKey };
  await ask({ type: "file-signal", exchangeUrl: policy.exchangeUrl, context });
  if (tested) return;
  const { spki } = await ask({ type: "identity-spki" });
  await writeSignal(`provisioned-${policy.generation}.json`, {
    generation: policy.generation,
    extensionVersion: chrome.runtime.getManifest().version,
    policyDigest: await hexDigest(bytes),
    workerSpki: spki,
  });
  tested = true;
};
