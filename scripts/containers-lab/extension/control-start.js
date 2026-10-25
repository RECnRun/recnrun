// Content script for every tab, after the prelude in the MAIN world: a tab without a container's
// prelude (B1 runs first) is a control tab and stops seeing the containers' names.
(() => {
  const { install, parts } = globalThis.rnrPrelude;
  delete globalThis.rnrPrelude;
  if (globalThis.__rnrSync) return;
  install({ container: "", control: true, marker: "__rnrControl" }, parts);
})();
