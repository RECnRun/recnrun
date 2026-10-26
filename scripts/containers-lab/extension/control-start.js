// Content script for every tab, after the prelude in the MAIN world: a tab without a container's
// prelude (B1 runs first) is a control tab and stops seeing the containers' names. A tab whose
// cookies name an identity (the swap mode of sessions.js) gets that identity's storage namespace
// over Chrome's own cookies and workers.
(() => {
  const { install, parts } = globalThis.rnrPrelude;
  delete globalThis.rnrPrelude;
  if (globalThis.__rnrSync) return;
  const cookie = typeof document === "undefined" ? "" : document.cookie;
  const container = /(?:^|; )__rnr=([^;]*)/.exec(cookie)?.[1];
  if (container) install({ container, control: false, native: true, marker: "__rnrSync" }, parts);
  else install({ container: "", control: true, marker: "__rnrControl" }, parts);
})();
