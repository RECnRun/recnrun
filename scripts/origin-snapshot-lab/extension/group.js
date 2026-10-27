// Experiment E: the tabs of a RECnRun tab group share the origin's identity and switch together.
// The others are parked on a halted gate document first, so no app document is left to touch
// storage while the lead tab captures, clears, and restores it.
import { marked, navigate } from "./navigation.js";

export const managed = new Set();
const NONE = -1;

export const partitionOf = (tab) => (tab.incognito ? "incognito" : "normal");

/** Puts the tab in a new RECnRun group titled with its identity. */
export async function manage(tabId, identity) {
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, { title: `RECnRun · ${identity}`, color: "red" });
  managed.add(groupId);
  return groupId;
}

export async function retitle(tab, identity) {
  if (managed.has(tab.groupId)) {
    await chrome.tabGroups.update(tab.groupId, { title: `RECnRun · ${identity}` });
  }
}

/** A tab the app opens from a managed tab joins its group; says who put it there, if anyone. */
export async function adopt(tab) {
  if (managed.has(tab.groupId)) return "chrome";
  if (tab.groupId !== NONE || tab.openerTabId === undefined) return "none";
  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => undefined);
  if (!opener || !managed.has(opener.groupId)) return "none";
  await chrome.tabs.group({ groupId: opener.groupId, tabIds: [tab.id] });
  return "extension";
}

const urlOf = (tab) => URL.parse(tab.url || tab.pendingUrl || "");

const onHosts = (hostname, hosts) =>
  hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));

/** A tab of the lead's partition: a group mate to take along, an outsider to refuse, or neither. */
function placeOf(tab, lead, cookieHosts) {
  const url = urlOf(tab);
  if (!url) return {};
  const mate = tab.groupId === lead.groupId;
  // The origin first: a cookie host may be its parent domain (google.com for mail.google.com).
  if (url.origin === new URL(lead.url).origin) {
    return mate ? { companion: { id: tab.id, url: marked(url.href) } } : { outside: url.pathname };
  }
  if (!onHosts(url.hostname, cookieHosts)) return {};
  // A mate mid sign-in: its sign-in page belongs to the identity, so it comes back at the app.
  if (!mate) throw new Error(`close the tab on ${url.hostname} first`);
  return { companion: { id: tab.id, url: marked(lead.url) } };
}

/** Groups titled by the lab survive the worker; its memory of them does not. */
export async function recoverGroups() {
  for (const group of await chrome.tabGroups.query({})) {
    if (group.title?.startsWith("RECnRun · ")) managed.add(group.id);
  }
}

/**
 * The lead's group mates on its origin or on a cookie host (or its subdomains). Tabs of the same storage partition on
 * the origin outside the group, or on a cookie host, refuse the switch. A lead outside any group
 * switches alone.
 */
export async function companionsOf(lead, cookieHosts) {
  if (!managed.has(lead.groupId)) return [];
  const places = (await chrome.tabs.query({}))
    .filter((tab) => tab.id !== lead.id && tab.incognito === lead.incognito)
    .map((tab) => placeOf(tab, lead, cookieHosts));
  const outside = places.flatMap((place) => place.outside ?? []);
  if (outside.length > 0) {
    const origin = new URL(lead.url).origin;
    throw new Error(`tabs of ${origin} outside the RECnRun group: ${outside.join(", ")}`);
  }
  return places.flatMap((place) => place.companion ?? []);
}

const inTab = async (tabId, func, args = []) =>
  (
    await chrome.scripting.executeScript({ target: { tabId }, injectImmediately: true, args, func })
  )[0]?.result;

/** sessionStorage is per tab: a capture keeps each tab's, by tab id, and the lead's as `session`. */
export const sessionFor = (target, tabId) =>
  target.tabs ? (target.tabs[tabId] ?? []) : target.session;

/** Each parked companion's sessionStorage, read in its halted gate document. */
export async function sessionsOf(companions) {
  const read = () => Object.entries(sessionStorage);
  const entries = await Promise.all(
    companions.map(async (tab) => [tab.id, await inTab(tab.id, read)]),
  );
  return Object.fromEntries(entries);
}

/** Replaces each parked companion's sessionStorage with the target's for that tab. */
export function restoreSessions(companions, target) {
  const write = (entries) => {
    sessionStorage.clear();
    for (const [key, value] of entries) sessionStorage.setItem(key, value);
  };
  return Promise.all(companions.map((tab) => inTab(tab.id, write, [sessionFor(target, tab.id)])));
}

/** Halts each companion on a gate document that does nothing; resolves once all committed. */
export const park = (companions, nonce) =>
  Promise.all(
    companions.map((tab) =>
      navigate(tab.id, marked(tab.url, "__recnrun_gate", `${nonce}.park`), { replace: true }),
    ),
  );

/** Reloads each companion at its `next` URL under the identity the lead restored. */
export const unpark = (companions) =>
  Promise.all(companions.map((tab) => navigate(tab.id, tab.next, { replace: true })));
