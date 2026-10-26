// Session rules per container tab and a non-blocking webRequest observer that moves each
// Set-Cookie into the container's jar. In N1 the rules also write the Cookie header, so they change
// asynchronously after each response; N1r also reloads a navigation that left with a stale Cookie
// header. In N2 they write it only for WebSocket handshakes. A tab no scan has classified yet gets
// no cookies; its Set-Cookie headers wait until it is classified, and its navigation then reloads.
import { record } from "./events.js";
import { jarOf, settled, storeHeaders } from "./jar-store.js";
import { cookieHeader, siteOf } from "./jar.js";
import { isProbeRule } from "./bootstraps.js";
import { buildRules } from "./dnr-rules.js";
import { containerForResponse } from "./documents.js";
import { isBlockRule } from "./sessions-block.js";
import { setRealCookies } from "./real-jar.js";
import { containerOf } from "./registry.js";

const URLS = ["http://app.localhost/*", "http://idp.localhost/*"];
let mode = "off";
let current = new Map();
let classified = [];
const repaired = new Map();
// When the rules first covered each tab, and what happened in a tab before that.
const classifiedAt = new Map();
const early = new Map();
const writesCookies = () => mode === "N1" || mode === "N1r";
const isEarly = ({ tabId, timeStamp }) => tabId >= 0 && !(classifiedAt.get(tabId) <= timeStamp);

function earlyEntry(tabId) {
  if (!early.has(tabId)) early.set(tabId, { cookies: [], navigation: undefined });
  return early.get(tabId);
}

async function applyNow() {
  const byContainer = new Map();
  for (const [tabId, container] of current)
    byContainer.set(container, [...(byContainer.get(container) ?? []), tabId]);
  const containers = await Promise.all(
    [...byContainer].map(async ([container, tabIds]) => ({ tabIds, jar: await jarOf(container) })),
  );
  const known = classified;
  const options = { knownTabIds: known, cookieTypes: writesCookies() ? undefined : ["websocket"] };
  const addRules = mode === "off" ? [] : buildRules(containers, Date.now(), options);
  const removeRuleIds = (await chrome.declarativeNetRequest.getSessionRules())
    .map(({ id }) => id)
    .filter((id) => !isProbeRule(id) && !isBlockRule(id));
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
  const now = Date.now();
  for (const tabId of known) if (!classifiedAt.has(tabId)) classifiedAt.set(tabId, now);
}

let applying = Promise.resolve();

/** One update at a time: concurrent updates would remove stale ids and add duplicates. */
function applyRules() {
  const run = applying.then(applyNow);
  applying = run.catch((error) => record("rules-failed", { error: String(error) }));
  return run;
}

async function storeEarly(tabId, cookies) {
  const container = containerOf(tabId);
  for (const { values, url } of cookies) {
    if (container) await storeHeaders(container, values, url);
    else await setRealCookies(values, url);
  }
  return container;
}

/** Moves what a tab did before it was classified to its jar, and reloads its navigation. */
async function settleEarly() {
  for (const [tabId, { cookies, navigation }] of early) {
    if (!classifiedAt.has(tabId)) continue;
    early.delete(tabId);
    const container = await storeEarly(tabId, cookies);
    record("early-tab-settled", { tabId, container, cookies: cookies.length, navigation });
    if (navigation) await chrome.tabs.reload(tabId).catch(() => {});
  }
}

/**
 * `variant` "N1", "N1r", or "N2" installs the rules for the assigned tabs; "off" removes them.
 * `known` lists the tabs that may have cookies: the control's and the ready containers' tabs.
 */
export async function syncRules(assignments, variant, known) {
  mode = variant;
  current = new Map([...assignments].filter(([tabId]) => known.includes(tabId)));
  classified = known;
  await applyRules();
  await settleEarly();
}

export async function jarChanged() {
  if (mode !== "off") await applyRules();
}

const setCookiesOf = (headers) =>
  headers.filter(({ name }) => name.toLowerCase() === "set-cookie").map(({ value }) => value ?? "");

/** Whose jar a managed tab's Set-Cookie headers belong to; `null` drops them. */
function ownerOf(details, values) {
  const managed = containerForResponse(details);
  if (managed === null && values.length > 0) {
    record("set-cookie-dropped", { tabId: details.tabId, url: details.url });
  }
  return managed === null ? null : (managed ?? containerOf(details.tabId));
}

async function observe(details) {
  if (mode === "off") return;
  const { tabId, url, responseHeaders = [], statusCode } = details;
  const values = setCookiesOf(responseHeaders);
  const container = ownerOf(details, values);
  if (container === null) return;
  // A tab the rules do not cover yet keeps its Set-Cookie headers until it is known to be the control's.
  if (isEarly(details) && !container) {
    if (values.length > 0) earlyEntry(tabId).cookies.push({ values, url });
    return;
  }
  if (!container) return;
  record("set-cookie-seen", { tabId, url, statusCode, setCookies: values.length });
  if (values.length === 0) return;
  await storeHeaders(container, values, url);
  record("jar-updated", { tabId, url });
}

/** Whether a navigation left with another Cookie header than the jar now gives it. */
async function isStale(container, { url, method, initiator, requestHeaders = [] }) {
  await settled();
  const crossSite = initiator !== undefined && siteOf(initiator) !== siteOf(url);
  const options = { now: Date.now(), crossSite, topLevelNavigation: true, method };
  const expected = cookieHeader(await jarOf(container), url, options);
  return (
    (requestHeaders.find(({ name }) => name.toLowerCase() === "cookie")?.value ?? "") !== expected
  );
}

/** N1r: a GET navigation that left before the rules caught up is loaded again. */
async function repair(details) {
  const { tabId, url, method } = details;
  const container = mode === "N1r" ? containerOf(tabId) : undefined;
  if (!container || method !== "GET" || !(await isStale(container, details))) return;
  record("stale-navigation", { tabId, url });
  // One reload per tab and URL every two seconds: a scope the rules approximate must not loop.
  if (Date.now() - (repaired.get(`${tabId} ${url}`) ?? 0) < 2000) return;
  repaired.set(`${tabId} ${url}`, Date.now());
  await chrome.tabs.update(tabId, { url });
}

function onNavigation(details) {
  if (mode === "off") return;
  if (isEarly(details)) earlyEntry(details.tabId).navigation = details.url;
  else void repair(details);
}

export function startRules() {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => void observe(details),
    { urls: URLS },
    ["responseHeaders", "extraHeaders"],
  );
  chrome.webRequest.onSendHeaders.addListener(onNavigation, { urls: URLS, types: ["main_frame"] }, [
    "requestHeaders",
    "extraHeaders",
  ]);
  chrome.tabs.onRemoved.addListener((tabId) => {
    classifiedAt.delete(tabId);
    const cookies = early.get(tabId)?.cookies ?? [];
    early.delete(tabId);
    // A popup can close before the debugger holds it; whoever it signed in still counts.
    if (cookies.length > 0) void storeEarly(tabId, cookies);
  });
}
