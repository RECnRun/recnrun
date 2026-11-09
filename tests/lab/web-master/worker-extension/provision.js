// The provision every gate reads: the launcher's policy.json, else the lab harness's storage entry.
import { createProvision } from "./policy.js";

// An absent file, or a context with no extension URL, falls back to storage.
const readPolicy = async () => {
  try {
    const response = await fetch(chrome.runtime.getURL("policy.json"), { cache: "no-store" });
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
};

const readStorage = async () => (await chrome.storage.local.get("provision")).provision;

export const provision = createProvision({ readPolicy, readStorage });
