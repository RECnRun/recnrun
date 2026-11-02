// Module service worker that also tries a dynamic import(); the outcome is recorded in the ledger.
import "./sw-main.js";

import("./sw-lazy.js").then(
  () => fetch("http://api.localhost:4601/__marker?name=sw:dynamic-import:ok"),
  (error) =>
    fetch(
      `http://api.localhost:4601/__marker?name=sw:dynamic-import:${encodeURIComponent(error.name)}`,
    ),
);
