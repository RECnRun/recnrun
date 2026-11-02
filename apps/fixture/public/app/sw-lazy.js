// Loaded only through a dynamic import() from a service worker.
void fetch("http://api.localhost:4601/me?from=sw-lazy", { credentials: "include" });
