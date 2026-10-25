// declarativeNetRequest session rules that give each container's tabs its own Cookie header (N1;
// in N2 only for WebSocket handshakes, which the debugger's Fetch domain does not see) and keep
// Set-Cookie out of Chrome's jar. Header values are static, so each rule holds the
// header for one cookie scope (domain and path), computed when the jar changes.
import { cookieHeader } from "./jar.js";

const ALL_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
];

const escape = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isLocal = (host) => host === "localhost" || host.endsWith(".localhost");

function scopesOf(jar) {
  const scopes = new Map();
  for (const { domain, hostOnly, path } of jar)
    scopes.set(`${hostOnly}|${domain}|${path}`, { domain, hostOnly, path });
  return [...scopes.values()];
}

function regexOf({ domain, hostOnly, path }) {
  const host = hostOnly ? escape(domain) : `([^/]+\\.)?${escape(domain)}`;
  const tail = path === "/" ? "/" : `${escape(path)}([/?#]|$)`;
  return `^(https?|wss?)://${host}(:[0-9]+)?${tail}`;
}

const STRIP_SET_COOKIE = {
  type: "modifyHeaders",
  responseHeaders: [{ header: "set-cookie", operation: "remove" }],
};

const BYPASS_CACHE = {
  type: "modifyHeaders",
  requestHeaders: [{ header: "cache-control", operation: "set", value: "no-cache" }],
};

const REMOVE_COOKIE = { header: "cookie", operation: "remove" };

function cookieAction(value) {
  const header = value ? { header: "cookie", operation: "set", value } : REMOVE_COOKIE;
  return { type: "modifyHeaders", requestHeaders: [header] };
}

/** First-party requests, cross-site top-level GET navigations, and other cross-site requests. */
function scopeRules(scope, { jar, tabIds }, { now, cookieTypes }) {
  const url = `${isLocal(scope.domain) ? "http" : "https"}://${scope.domain}${scope.path}`;
  const header = (options) => cookieHeader(jar, url, { now, ...options });
  const priority = 10 + 3 * scope.path.length;
  const base = { tabIds, regexFilter: regexOf(scope) };
  const navigation = { crossSite: true, topLevelNavigation: true, method: "GET" };
  const navigations = cookieTypes.includes("main_frame") ? ["main_frame"] : [];
  return [
    [priority + 2, { ...base, domainType: "firstParty", resourceTypes: cookieTypes }, header({})],
    [
      priority + 2,
      { ...base, domainType: "thirdParty", resourceTypes: navigations, requestMethods: ["get"] },
      header(navigation),
    ],
    [
      priority + 1,
      { ...base, domainType: "thirdParty", resourceTypes: cookieTypes },
      header({ crossSite: true }),
    ],
  ]
    .filter(([, condition]) => condition.resourceTypes.length > 0)
    .map(([rulePriority, condition, value]) => ({
      priority: rulePriority,
      condition,
      action: cookieAction(value),
    }));
}

/**
 * Every session rule, with ids from 1. `containers` is a list of `{ tabIds, jar }`. The rules write
 * the Cookie header for `cookieTypes` (N2 writes the rest with the debugger), strip Set-Cookie for
 * every type, and treat any tab missing from `knownTabIds` as unknown: no cookies in or out.
 */
export function buildRules(containers, now, { knownTabIds, cookieTypes = ALL_TYPES }) {
  const rules = [];
  for (const container of containers) {
    const { tabIds } = container;
    if (tabIds.length === 0) continue;
    rules.push({
      priority: 1,
      condition: { tabIds, resourceTypes: ALL_TYPES },
      action: STRIP_SET_COOKIE,
    });
    if (cookieTypes.length > 0)
      rules.push({
        priority: 1,
        condition: { tabIds, resourceTypes: cookieTypes },
        action: cookieAction(""),
      });
    for (const scope of scopesOf(container.jar))
      rules.push(...scopeRules(scope, container, { now, cookieTypes }));
  }
  // Requests outside tabs (tabId -1, such as service workers) keep Chrome's own jar.
  const unknown = { excludedTabIds: [...knownTabIds, -1], resourceTypes: ALL_TYPES };
  rules.push({
    priority: 1,
    condition: unknown,
    action: { ...STRIP_SET_COOKIE, requestHeaders: [REMOVE_COOKIE] },
  });
  // The HTTP cache is keyed by URL, not by Cookie, so a cached private response would reach any tab.
  rules.push({ priority: 1, condition: { resourceTypes: ALL_TYPES }, action: BYPASS_CACHE });
  return rules.map((rule, index) => ({ id: index + 1, ...rule }));
}
