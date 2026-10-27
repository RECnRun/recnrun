// The lab's service worker: routes the page scripts' messages and exposes `globalThis.lab`,
// the handle the specs call through Playwright.
import { adopt, manage, managed } from "./group.js";
import { marked } from "./navigation.js";
import { allCaptures, clearCaptures, deletePartition, getCapture, summarize } from "./repo.js";
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

chrome.tabs.onCreated.addListener((tab) => {
  adopt(tab).then(
    (by) => events.push({ step: "tab created", groupedBy: by, at: Date.now() }),
    (error) => events.push({ step: "adopt failed", error: String(error) }),
  );
});

/** Incognito captures last no longer than the incognito session: gone once its last window is. */
async function purgeIncognito() {
  const windows = await chrome.windows.getAll();
  if (windows.some((each) => each.incognito)) return;
  forgetTabs("incognito");
  await deletePartition("incognito");
}
chrome.windows.onRemoved.addListener(() => void purgeIncognito());
void purgeIncognito();

globalThis.lab = {
  ready: () => true,
  configure: (values) => Object.assign(options, values),
  register,
  switchTo,
  manage: async (tabId) => manage(tabId, options.firstIdentity),
  probeOffscreen,
  // The manual run's lead: a tab of the origin in a RECnRun group, the active one if it can.
  leadFor: async (origin, incognito) => {
    const grouped = (await chrome.tabs.query({})).filter(
      (tab) =>
        tab.incognito === incognito &&
        managed.has(tab.groupId) &&
        URL.parse(tab.url ?? "")?.origin === origin,
    );
    const lead = grouped.find((tab) => tab.active) ?? grouped[0];
    if (!lead) throw new Error(`no tab of ${origin} in the RECnRun group`);
    return lead.id;
  },
  activeTabId: async () =>
    (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id,
  // A tab's cookies by name, domain, and size, from its own cookie store; never the values.
  cookieInventory: async (tabId) => {
    const stores = await chrome.cookies.getAllCookieStores();
    const storeId = stores.find((store) => store.tabIds.includes(tabId))?.id;
    return (await chrome.cookies.getAll({ storeId })).map(({ value, ...cookie }) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      session: cookie.session,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      chars: value.length,
    }));
  },
  // Experiment E: the RECnRun group a tab belongs to, as the specs see it.
  groupOf: async (tabId) => {
    const { groupId } = await chrome.tabs.get(tabId);
    if (groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return null;
    const group = await chrome.tabGroups.get(groupId);
    return { id: groupId, title: group.title };
  },
  tabIdFor: async (prefix) =>
    (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(prefix))?.id,
  capture: async (origin, identity, partition) => {
    const record = await getCapture(origin, identity, partition);
    return record && { lastUrl: record.lastUrl, ...summarize(record.state) };
  },
  captures: async () =>
    (await allCaptures())
      .map(({ identity, partition }) =>
        partition === "incognito" ? `${identity} (incognito)` : identity,
      )
      .sort((a, b) => a.localeCompare(b)),
  reset: async () => {
    forgetTabs();
    events.length = 0;
    await clearCaptures();
  },
  events: () => events,
};
