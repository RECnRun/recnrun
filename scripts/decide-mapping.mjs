// Maps each P1 hypothesis (experiment/hypothesis[/variant]) to the capability and route it tells about.
export const ROUTES = ["A", "B", "C"];

export const CAPABILITIES = [
  "page",
  "dedicated",
  "shared",
  "serviceWorker.first",
  "serviceWorker.update",
  "serviceWorker.cold",
  "serviceWorker.offline",
  "serviceWorker.wake",
];

/** The spec behind each experiment, so every row of the report cites one. */
export const SPECS = {
  E0: "tests/experiments/E0-load-extension.spec.ts",
  E1: "tests/experiments/E1-debugger-capabilities.spec.ts",
  E2: "tests/experiments/E2-route-a-register.spec.ts",
  E3: "tests/experiments/E3-route-a-cold.spec.ts",
  E4: "tests/experiments/E4-stop-restart.spec.ts",
  E5: "tests/experiments/E5-route-b-fetch.spec.ts",
  E6: "tests/experiments/E6-route-b-selection.spec.ts",
  E7: "tests/experiments/E7-route-c-pages-workers.spec.ts",
  E8: "tests/experiments/E8-strict.spec.ts",
};

/** Experiments that probe what Chrome allows, not a route, and so feed no cell. */
export const NOT_MAPPED = {
  E0: "extension loading methods; a precondition of every route",
  E1: "what chrome.debugger can do; a precondition of Routes A and B",
  E8: "d-other-clients: no other debugger client in the strict lab; a precondition of E8",
};

const SW = "serviceWorker";

// Keys are "E<n>/<hypothesis>" or "E<n>/<hypothesis>/<variant>" (a trailing * matches a prefix).
const BY_ROUTE = {
  A: {
    [`${SW}.first`]: [
      [
        "E2/service-worker-register",
        "auto-attach before register(); caches is undefined at the pause",
      ],
      [
        "E3/before-script-execution/sw-*",
        "armed tab, auto-attach and a breakpoint hold each worker",
      ],
      [
        "E3/direct-attach-race/sw-*",
        "attaching by target id as getTargets() lists it loses the race",
      ],
      ["E8/a-cold-start", "the same hold in Chrome without CDP, the isolator installed by policy"],
    ],
    dedicated: [
      [
        "E2/dedicated-worker",
        "auto-attach before the worker starts; caches is undefined at the pause",
      ],
      ["E2/nested-worker", "the frozen fixture starts no worker from a worker"],
      [
        "E3/before-script-execution/dedicated-*",
        "armed tab, auto-attach and a breakpoint hold each worker",
      ],
      ["E3/direct-attach-race/dedicated-*", "attaching by target id loses the race"],
    ],
    shared: [["E2/shared-worker", "a tab session never auto-attaches shared workers (E1)"]],
    [`${SW}.cold`]: [
      ["E3/cold-start-navigation", "a navigation restarts a worker the isolator stopped"],
      ["E3/pre-existing-running", "a worker already running when Route A arrives"],
      ["E4/close-target", "Target.closeTarget stops the worker; the restart must be caught"],
      ["E4/terminate-execution", "Runtime.terminateExecution is refused to untrusted clients"],
      ["E4/debugger-pause", "a pause holds the worker without stopping it"],
      ["E4/dnr-block-evict", "a DNR block does not evict a running worker"],
      ["E4/unregister", "unregister() leaves the target listed"],
      ["E8/b-restart", "without CDP a reload after closeTarget restarts the worker marked"],
    ],
    [`${SW}.wake`]: [
      ["E3/wake-without-tab", "a worker woken with no tab open is attached by watch"],
    ],
  },
  B: {
    [`${SW}.first`]: [
      ["E5/first", "the main script is fulfilled with the wrapper on the first registration"],
      ["E5/imports", "importScripts and static imports pause on the worker session"],
      ["E5/imports-transform", "imports fulfilled too"],
      ["E5/tab-session-main-script", "the main script never pauses on the tab session"],
      ["E6/a-switch", "a slot switch without rewriting the stored script"],
    ],
    [`${SW}.update`]: [
      ["E5/update", "the update check is not interceptable"],
      ["E6/b-update", "the namespace survives update()"],
    ],
    [`${SW}.cold`]: [["E6/restart", "Chrome relaunched on the profile keeps the stored wrapper"]],
    [`${SW}.offline`]: [
      ["E5/offline", "a stopped worker restarts offline from the stored wrapper"],
      ["E5/fulfilled-worker-address-space", "a fulfilled worker leaves from Unknown"],
      ["E6/a-offline", "a slot switch while the fixture is offline"],
    ],
    dedicated: [
      ["E6/c-workers/dedicated:*", "the slot switch reaches dedicated workers"],
      ["E6/suspend/dedicated:*", "dedicated workers survive a suspended background"],
      ["E8/c-selection-workers/dedicated:*", "the same switch in Chrome without CDP"],
    ],
    shared: [
      ["E6/c-workers/shared:*", "the slot switch reaches shared workers"],
      ["E6/suspend/shared:*", "shared workers survive a suspended background"],
      ["E8/c-selection-workers/shared:*", "the same switch in Chrome without CDP"],
    ],
  },
  C: {
    page: [
      ["E7/page", "a registered content script marks the page before its first script"],
      ["E7/cross-site-iframe", "a cross-site frame is marked only when its origin is registered"],
      ["E7/popup", "a popup is marked before its first script"],
      ["E7/same-origin-iframe", "not exercisable on the frozen fixture"],
      ["E7/about-blank-child", "not exercisable on the frozen fixture"],
      ["E7/sandboxed-frame", "not exercisable on the frozen fixture"],
    ],
    dedicated: [["E7/dedicated-worker", "Route C refuses new Worker() rather than wrap it"]],
    shared: [
      ["E7/shared-worker", "Route C refuses new SharedWorker() rather than wrap it"],
      ["E7/shared-worker-identity", "a blob wrapper splits one shared worker into two"],
    ],
  },
};

/** One flat row per mapped hypothesis. */
export const MAPPING = Object.entries(BY_ROUTE).flatMap(([route, capabilities]) =>
  Object.entries(capabilities).flatMap(([capability, rows]) =>
    rows.map(([key, reason]) => {
      const [experiment, hypothesis, variant] = key.split("/");
      return { experiment, hypothesis, variant, capability, route, reason };
    }),
  ),
);
