// Probes for bootstraps B2 and B4, measured against the page's first inline script. They only
// record what the page could know; the prelude itself comes from B1 or the control script.
const FIRST_ID = 10000;
const LAST_ID = 19999;
let on = false;
/** @type {(tabId: number) => string | undefined} */
let probeContainer = () => undefined;

const tagRule = (container, tabIds, index) => ({
  id: FIRST_ID + index,
  priority: 1,
  condition: { tabIds, urlFilter: "/__rnr/container", resourceTypes: ["xmlhttprequest"] },
  action: {
    type: "modifyHeaders",
    responseHeaders: [{ header: "x-rnr-container", operation: "set", value: container }],
  },
});

/** Session rule ids the network rules must leave alone. */
export const isProbeRule = (id) => id >= FIRST_ID && id <= LAST_ID;

export async function syncProbes(assignments) {
  const byContainer = new Map();
  for (const [tabId, container] of assignments)
    byContainer.set(container, [...(byContainer.get(container) ?? []), tabId]);
  const addRules = on
    ? [...byContainer].map(([container, tabIds], index) => tagRule(container, tabIds, index))
    : [];
  const removeRuleIds = (await chrome.declarativeNetRequest.getSessionRules())
    .map(({ id }) => id)
    .filter(isProbeRule);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
}

export async function setProbes(next, assignments, containerOf) {
  on = next;
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: ["b2-probe"] });
  if (registered.length > 0) await chrome.scripting.unregisterContentScripts({ ids: ["b2-probe"] });
  if (on) {
    const script = {
      id: "b2-probe",
      js: ["b2-probe.js"],
      matches: ["http://app.localhost/*"],
      world: "MAIN",
      runAt: "document_start",
      allFrames: true,
      persistAcrossSessions: false,
    };
    await chrome.scripting.registerContentScripts([script]);
  }
  probeContainer = containerOf;
  await syncProbes(assignments);
}

/** B4: inject on commit and see whether it beats the first inline script. */
export function startProbes() {
  chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
    const container = on ? probeContainer(tabId) : undefined;
    if (!container) return;
    const injection = {
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      injectImmediately: true,
      args: [container],
    };
    void chrome.scripting
      .executeScript({ ...injection, func: (value) => (window.__b4 = value) })
      .catch(() => {});
  });
}
