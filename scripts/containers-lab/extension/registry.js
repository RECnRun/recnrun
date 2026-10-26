// Which container each tab belongs to. A tab group is a container, named by its title (group ids
// change across restarts); a tab opened from a container tab outside any group, such as a popup,
// inherits its opener's container.
import { record } from "./events.js";

const inherited = new Map();
// Single-tab sessions (sessions.js) pin a tab to a container regardless of its group.
const pinned = new Map();
let assignments = new Map();
let known = new Set();
let queue = Promise.resolve();
let onSync = async () => {};

const containerIdOf = (title) => (title ? title.trim().toLowerCase() : undefined);

async function groupTitles() {
  const groups = await chrome.tabGroups.query({});
  return new Map(groups.map((group) => [group.id, containerIdOf(group.title)]));
}

async function scan() {
  const [tabs, titles] = await Promise.all([chrome.tabs.query({}), groupTitles()]);
  const next = new Map();
  // A tab in a group without a title yet, such as one just made by "Add tab to new group", waits.
  known = new Set(
    tabs.filter(({ groupId }) => groupId === -1 || titles.get(groupId)).map(({ id }) => id),
  );
  for (const tab of tabs) {
    const fromGroup = tab.groupId === -1 ? undefined : titles.get(tab.groupId);
    const container =
      pinned.get(tab.id) ?? fromGroup ?? (tab.groupId === -1 ? inherited.get(tab.id) : undefined);
    if (container) next.set(tab.id, container);
  }
  return next;
}

/** Rescans every tab and hands the assignments to the engines, one scan at a time. */
export function refresh() {
  const run = queue.then(async () => {
    assignments = await scan();
    await onSync(assignments);
  });
  // A failed sync must not stop the scans after it.
  queue = run.catch((error) => record("sync-failed", { error: String(error) }));
  return run;
}

export const containerOf = (tabId) => assignments.get(tabId);

/** Pins `tabId` to `container` (undefined unpins); the next `refresh()` applies it. */
export function pin(tabId, container) {
  if (container === undefined) pinned.delete(tabId);
  else pinned.set(tabId, container);
}

/** Every tab the last scan classified, as a container's or as a control tab. */
export const knownTabs = () => known;

function inherit(tabId, openerTabId) {
  const container = openerTabId === undefined ? undefined : assignments.get(openerTabId);
  if (!container) return;
  inherited.set(tabId, container);
  void refresh();
}

/** Starts tracking groups and openers; `sync(assignments)` runs after every change. */
export function startRegistry(sync) {
  onSync = sync;
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.groupId === -1) inherit(tab.id, tab.openerTabId);
    else void refresh();
  });
  chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) =>
    inherit(tabId, sourceTabId),
  );
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (!("groupId" in change)) return;
    if (change.groupId !== -1) inherited.delete(tabId);
    void refresh();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    inherited.delete(tabId);
    pinned.delete(tabId);
    void refresh();
  });
  chrome.tabGroups.onUpdated.addListener(() => void refresh());
  return refresh();
}
