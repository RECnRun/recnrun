// Navigates a tab and resolves once the main frame committed that URL (query included).
const withoutHash = (url) => {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
};

/** `replace` navigates from the tab's document with location.replace, dropping its history entry. */
function start(tabId, url, replace) {
  if (!replace) return chrome.tabs.update(tabId, { url });
  return chrome.scripting.executeScript({
    target: { tabId },
    args: [url],
    // The halted gate document never reaches document_idle, where injection waits by default.
    injectImmediately: true,
    func: (next) => location.replace(next),
  });
}

export function navigate(tabId, url, { replace = false, timeoutMs = 15000 } = {}) {
  const wanted = withoutHash(url);
  return new Promise((resolve, reject) => {
    let timer;
    const listener = (details) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      if (withoutHash(details.url) !== wanted) return;
      cleanup();
      resolve({ documentId: details.documentId, url: details.url, at: performance.now() });
    };
    const cleanup = () => {
      clearTimeout(timer);
      chrome.webNavigation.onCommitted.removeListener(listener);
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`navigation to ${url} did not commit in ${timeoutMs} ms`));
    }, timeoutMs);
    chrome.webNavigation.onCommitted.addListener(listener);
    start(tabId, url, replace).catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

const MARKERS = ["__recnrun_gate", "__recnrun_a0"];

/** The URL without the lab's markers, with `name=value` added when given. */
export function marked(url, name, value) {
  const parsed = new URL(url);
  for (const marker of MARKERS) parsed.searchParams.delete(marker);
  if (name) parsed.searchParams.set(name, value);
  return parsed.href;
}
