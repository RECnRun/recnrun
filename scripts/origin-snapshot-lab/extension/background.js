// The lab's service worker: routes the page scripts' messages and exposes `globalThis.lab`,
// the handle the specs call through Playwright.
import { marked } from "./navigation.js";
import { allCaptures, clearCaptures, getCapture, summarize } from "./repo.js";
import { forgetTabs, onPageMessage, options, switchTo } from "./switch.js";

const probes = new Map();
const events = [];

async function register(origin) {
  const { protocol, hostname } = new URL(origin);
  await chrome.scripting.unregisterContentScripts();
  await chrome.scripting.registerContentScripts([
    {
      id: "origin-lab",
      matches: [`${protocol}//${hostname}/*`],
      js: ["page-storage.js", "gate.js", "a0.js"],
      runAt: "document_start",
      allFrames: true,
      persistAcrossSessions: false,
    },
  ]);
}

function onProbe(message, resolve) {
  if (message.gate === "ready") return { ok: true, delayMs: 0, clear: options.clear };
  if (message.gate === "captured") resolve({ summary: summarize(message.captured) });
  return { ok: false, error: "probe only" };
}

/** A3: an offscreen document frames the origin; the frame reports which storage it sees. */
async function probeOffscreen(url) {
  const nonce = crypto.randomUUID();
  const reported = new Promise((resolve) => probes.set(nonce, resolve));
  const src = marked(url, "__recnrun_gate", `${nonce}.a3`);
  await chrome.offscreen.createDocument({
    url: `offscreen.html?src=${encodeURIComponent(src)}`,
    reasons: ["IFRAME_SCRIPTING"],
    justification: "Origin snapshot lab, candidate A3",
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 10000));
  try {
    return await Promise.race([reported, timeout]);
  } finally {
    probes.delete(nonce);
    await chrome.offscreen.closeDocument();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || (message.gate === undefined && message.a0 === undefined)) return false;
  events.push({ step: message.gate ?? message.a0, nonce: message.nonce, at: Date.now() });
  const probe = probes.get(message.nonce);
  const answer = probe ? Promise.resolve(onProbe(message, probe)) : onPageMessage(message, sender);
  answer.then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

globalThis.lab = {
  ready: () => true,
  configure: (values) => Object.assign(options, values),
  register,
  switchTo,
  probeOffscreen,
  // The tabs Chrome shows on `origin`, by id and path; queries and fragments may hold tokens.
  originTabs: async (origin) =>
    (await chrome.tabs.query({}))
      .map((tab) => ({ id: tab.id, url: URL.parse(tab.url ?? tab.pendingUrl ?? "") }))
      .filter(({ url }) => url?.origin === origin)
      .map(({ id, url }) => ({ id, path: url.pathname })),
  tabIdFor: async (prefix) =>
    (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(prefix))?.id,
  capture: async (origin, identity) => {
    const record = await getCapture(origin, identity);
    return record && { lastUrl: record.lastUrl, ...summarize(record.state) };
  },
  captures: async () =>
    (await allCaptures()).map((record) => record.identity).sort((a, b) => a.localeCompare(b)),
  reset: async () => {
    forgetTabs();
    events.length = 0;
    await clearCaptures();
  },
  events: () => events,
};
