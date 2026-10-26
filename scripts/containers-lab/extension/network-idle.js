// The requests in flight per tab, from webRequest alone (no debugger). The swap mode waits for a
// tab's network to drain between the neutral document's commit and saving the cookie store, so a
// late Set-Cookie lands in the jar of the identity that asked for it. A request counts from
// onBeforeRequest to onCompleted or onErrorOccurred; a keepalive request outlives its document
// and still completes here, a plain one is aborted with its document.
const URLS = ["http://app.localhost/*", "http://idp.localhost/*"];
const pending = new Map();
const waiters = new Set();

function begin({ requestId, tabId, url, type }) {
  if (tabId < 0) return;
  pending.set(requestId, { tabId, url, type, startedAt: Date.now() });
}

function end({ requestId }) {
  if (!pending.delete(requestId)) return;
  for (const waiter of waiters) waiter();
}

/** The requests of `tabId` still in flight, oldest first. */
export const pendingOf = (tabId) =>
  [...pending.values()]
    .filter((request) => request.tabId === tabId)
    .map(({ url, type, startedAt }) => ({ url, type, startedAt }));

/**
 * Resolves once `tabId` has no request in flight, or after `timeoutMs` with the ones still
 * pending: `{ ms, awaited, pending, timedOut }`.
 */
export function waitForIdle(tabId, timeoutMs = 5000) {
  const started = Date.now();
  const awaited = pendingOf(tabId);
  return new Promise((resolve) => {
    const finish = () => {
      waiters.delete(check);
      clearTimeout(timer);
      const left = pendingOf(tabId);
      resolve({ ms: Date.now() - started, awaited, pending: left, timedOut: left.length > 0 });
    };
    const check = () => {
      if (pendingOf(tabId).length === 0) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    waiters.add(check);
    check();
  });
}

export function startNetworkIdle() {
  chrome.webRequest.onBeforeRequest.addListener(begin, { urls: URLS });
  chrome.webRequest.onCompleted.addListener(end, { urls: URLS });
  chrome.webRequest.onErrorOccurred.addListener(end, { urls: URLS });
}
