// The dashboard's commands (dashboard.html): the person tests from a page of the extension instead
// of the service worker's console. Only that page may send them: the lab's content scripts run in
// the app's tabs, and their messages carry the app's URL.
import { saveSettings, site } from "./console.js";
import { managed, partitionOf } from "./group.js";
import { allCaptures } from "./repo.js";
import { identityOf, options } from "./switch.js";

const DASHBOARD = chrome.runtime.getURL("dashboard.html");

/** Focuses the dashboard's tab, or opens one. */
export async function openDashboard() {
  const [open] = await chrome.tabs.query({ url: DASHBOARD });
  if (!open) return chrome.tabs.create({ url: DASHBOARD });
  await chrome.windows.update(open.windowId, { focused: true });
  return chrome.tabs.update(open.id, { active: true });
}

/** A capture as the dashboard lists it: counts only, never a value. */
const listed = ({ identity, capturedAt, lastUrl, state }) => ({
  identity,
  capturedAt,
  lastUrl,
  local: state.local.length,
  databases: state.databases.length,
  cookies: state.cookies?.length ?? 0,
});

/** "lost" when captures exist but the worker restarted; the first identity once grouped. */
function identityIn(partition, captures, grouped) {
  const known = identityOf(partition, site.origin);
  if (known) return known;
  if (captures.length > 0) return "lost";
  return grouped > 0 ? options.firstIdentity : null;
}

async function status({ incognito = false }) {
  if (!site.origin) return { origin: null };
  const partition = incognito ? "incognito" : "normal";
  const tabs = (await chrome.tabs.query({})).filter(
    (tab) => partitionOf(tab) === partition && URL.parse(tab.url ?? "")?.origin === site.origin,
  );
  const grouped = tabs.filter((tab) => managed.has(tab.groupId)).length;
  const captures = (await allCaptures())
    .filter((record) => record.partition === partition && record.origin === site.origin)
    .map(listed)
    .sort((a, b) => a.identity.localeCompare(b.identity));
  return {
    origin: site.origin,
    cookieHosts: options.cookieHosts,
    forceClear: options.forceClear,
    incognitoAllowed: await chrome.extension.isAllowedIncognitoAccess(),
    identity: identityIn(partition, captures, grouped),
    tabs: tabs.length,
    grouped,
    captures,
  };
}

function commands() {
  if (!site.rec)
    throw new Error("this copy has no site: write it with origin-snapshot-lab:unpacked");
  return site.rec;
}

const actions = {
  status,
  start: ({ incognito }) => commands().start(incognito),
  switch: ({ to, incognito }) => commands().switch(to, incognito),
  reset: ({ to, incognito }) => commands().reset(to, incognito),
  restoreCookies: ({ to, incognito }) => commands().restoreCookies(to, incognito),
  settings: saveSettings,
  forget: () => globalThis.lab.reset(),
};

export async function onUiMessage(message, sender) {
  if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/)[0] !== DASHBOARD) {
    return { ok: false, error: "not from the dashboard" };
  }
  if (!Object.hasOwn(actions, message.ui)) return { ok: false, error: `unknown ${message.ui}` };
  try {
    return { ok: true, result: await actions[message.ui](message) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
