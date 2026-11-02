// Imported scripts are part of the worker too: this one makes its own authenticated request.
void fetch("http://api.localhost:4601/me?from=sw-imported", { credentials: "include" });
