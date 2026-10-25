// Bootstrap B2 probe (content script, MAIN world, document_start): a synchronous same-origin request
// whose response a per-tab session rule tags with the tab's container.
(() => {
  const started = performance.now();
  const request = new XMLHttpRequest();
  try {
    request.open("GET", `/__rnr/container?${Math.random()}`, false);
    request.send();
    window.__b2 = {
      container: request.getResponseHeader("x-rnr-container"),
      ms: performance.now() - started,
    };
  } catch (error) {
    window.__b2 = { error: String(error) };
  }
})();
