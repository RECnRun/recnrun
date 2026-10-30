// A session rule that blocks every request of a tab whose identity is unknown: a failed switch, or
// a managed tab the debugger no longer holds. It works without the debugger, so a detached tab
// never falls back to Chrome's own jar.
const FIRST_ID = 20000;

const TYPES = [
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

/** Session rule ids the network and probe rules must leave alone. */
export const isBlockRule = (id) => id >= FIRST_ID;

const ruleId = (tabId) => FIRST_ID + tabId;

export function blockTab(tabId) {
  return chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId(tabId)],
    addRules: [
      {
        id: ruleId(tabId),
        priority: 100,
        condition: { tabIds: [tabId], resourceTypes: TYPES },
        action: { type: "block" },
      },
    ],
  });
}

export function unblockTab(tabId) {
  return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId(tabId)] });
}
