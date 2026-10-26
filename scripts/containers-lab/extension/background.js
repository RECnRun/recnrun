// The lab extension's service worker. `globalThis.lab` is the harness's handle (Playwright
// evaluates it); the variant is "off", "N1", "N1r", "N2", or "N2B1" (N2 with the B1 prelude).
import { setB1, startB1 } from "./b1.js";
import { setProbes, startProbes, syncProbes } from "./bootstraps.js";
import { commitsOf, startDocuments } from "./documents.js";
import { clearEvents, events, record } from "./events.js";
import { clearJar, jarOf, onJarChanged } from "./jar-store.js";
import { isAttached, startN2, syncN2 } from "./n2.js";
import { startNetworkIdle } from "./network-idle.js";
import { knownTabs, refresh, startRegistry } from "./registry.js";
import { jarChanged, startRules, syncRules } from "./rules.js";
import { activate, failNext, isManaged, sessions, startSessions } from "./sessions.js";
import { setDomains } from "./swap.js";

let variant = "off";
let assignments = new Map();

const lastClass = new Map();

/**
 * Tabs classified under another container (or the control) than last time: their documents hold
 * its prelude. A managed tab switches through its own transition instead of a reload.
 */
function movedTabs(next, classified) {
  const moved = [];
  for (const tabId of classified) {
    const now = next.get(tabId) ?? "";
    if (lastClass.has(tabId) && lastClass.get(tabId) !== now && !isManaged(tabId))
      moved.push(tabId);
    lastClass.set(tabId, now);
  }
  return moved;
}

async function reloadWeb(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab?.url?.startsWith("http")) await chrome.tabs.reload(tabId);
}

async function sync(next) {
  assignments = next;
  setB1(variant === "N2B1");
  const n2 = variant.startsWith("N2");
  await syncN2(next, n2);
  // In N2 a container tab is classified once the debugger holds it; until then it gets no cookies.
  const classified = [...knownTabs()].filter(
    (tabId) => !n2 || !next.has(tabId) || isAttached(tabId),
  );
  await syncRules(next, variant, classified);
  for (const tabId of movedTabs(next, classified)) await reloadWeb(tabId);
  await syncProbes(next);
  record("synced", { variant, tabs: [...next] });
}

async function groupFor(tab, title) {
  const [existing] = await chrome.tabGroups.query({ title, windowId: tab.windowId });
  if (existing) return chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id });
  const groupId = await chrome.tabs.group({
    tabIds: [tab.id],
    createProperties: { windowId: tab.windowId },
  });
  await chrome.tabGroups.update(groupId, { title });
  return groupId;
}

/** Opens a blank tab in the group titled `title` (or ungrouped), as "New tab in group" does. */
async function openTab(title, token) {
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`blank.html#${token}`),
    active: false,
  });
  if (title) await groupFor(tab, title);
  await refresh();
  return tab.id;
}

async function setVariant(next) {
  variant = next;
  await chrome.storage.local.set({ variant });
  await sync(assignments);
}

globalThis.lab = {
  setVariant,
  setProbes: (on) => setProbes(on, assignments, (tabId) => assignments.get(tabId)),
  openTab,
  refresh,
  events,
  clearEvents,
  jar: jarOf,
  clearJar,
  assignments: () => [...assignments],
  realCookies: () => chrome.cookies.getAll({}),
  setRealCookie: (details) => chrome.cookies.set(details),
  targets: () => chrome.debugger.getTargets(),
  evaluateIn: async (title, expression) => {
    const target = (await chrome.debugger.getTargets()).find(
      (candidate) => candidate.title === title,
    );
    const result = await chrome.debugger.sendCommand({ targetId: target.id }, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return { target, result };
  },
  removeRealCookies: async (domain) => {
    for (const { name, path } of await chrome.cookies.getAll({ domain })) {
      await chrome.cookies.remove({ url: `http://${domain}${path}`, name });
    }
  },
  group: (tabId, title) => chrome.tabs.get(tabId).then((tab) => groupFor(tab, title)),
  ungroup: (tabId) => chrome.tabs.ungroup(tabId),
  // Lifecycle (Phase E): the tabs with their group titles, and what a user does to them.
  tabs: async () => {
    const titles = new Map((await chrome.tabGroups.query({})).map(({ id, title }) => [id, title]));
    return (await chrome.tabs.query({})).map(({ id, url, groupId }) => ({
      id,
      url,
      group: titles.get(groupId),
    }));
  },
  duplicate: (tabId) => chrome.tabs.duplicate(tabId).then(({ id }) => id),
  closeTab: (tabId) => chrome.tabs.remove(tabId),
  restoreLast: () =>
    chrome.sessions.restore().then((session) => session.tab?.id ?? session.window?.id),
  reloadExtension: () => setTimeout(() => chrome.runtime.reload(), 100),
  startedAt: () => startedAt,
  // Single-tab sessions: identities take turns in one tab (sessions.js).
  activate,
  failNext,
  sessions,
  commits: commitsOf,
  tabUrl: (tabId) => chrome.tabs.get(tabId).then(({ url }) => url),
  sessionRules: () => chrome.declarativeNetRequest.getSessionRules(),
  setDomains,
};
const startedAt = Date.now();

// The same handle for an extension page: Playwright does not see a restarted service worker.
chrome.runtime.onMessage.addListener(({ lab: method, args }, sender, reply) => {
  if (!method) return false;
  Promise.resolve(globalThis.lab[method](...args)).then(
    (value) => reply({ value }),
    (error) => reply({ error: String(error) }),
  );
  return true;
});
startRules();
startDocuments();
startNetworkIdle();
startSessions();
chrome.tabs.onRemoved.addListener((tabId) => lastClass.delete(tabId));
startN2(() => ready);
startB1();
startProbes();
onJarChanged(() => jarChanged());
const ready = chrome.storage.local.get("variant").then(async (stored) => {
  variant = stored.variant ?? "off";
  await startRegistry(sync);
});
globalThis.lab.ready = () => ready;
