// Each container's jar, kept in memory and written through to storage.local so it survives the
// service worker's suspension and a browser restart.
import { parseSetCookie, storeCookie } from "./jar.js";

const jars = new Map();
const listeners = new Set();
const key = (container) => `jar:${container}`;

export async function jarOf(container) {
  if (!jars.has(container)) {
    const stored = await chrome.storage.local.get(key(container));
    jars.set(container, stored[key(container)] ?? []);
  }
  return jars.get(container);
}

let pending = Promise.resolve();

/** Resolves once every store started so far is in memory and in storage. */
export const settled = () => pending;

/** Stores each `Set-Cookie` header (or script write) in the container's jar, one store at a time. */
export function storeHeaders(container, headers, requestUrl, options = {}) {
  pending = pending
    .then(() => store(container, headers, requestUrl, options))
    .catch((error) => console.error("Could not store cookies", error));
  return pending;
}

async function store(container, headers, requestUrl, options) {
  const now = Date.now();
  let jar = await jarOf(container);
  for (const header of headers)
    jar = storeCookie(jar, parseSetCookie(header, requestUrl, now, options), now);
  jars.set(container, jar);
  await chrome.storage.local.set({ [key(container)]: jar });
  for (const listener of listeners) await listener(container);
  return jar;
}

export async function clearJar(container) {
  jars.set(container, []);
  await chrome.storage.local.remove(key(container));
  for (const listener of listeners) await listener(container);
}

export const onJarChanged = (listener) => listeners.add(listener);
