import { BOOTSTRAP_SOURCE, withMarker } from "@recnrun/worker-bootstrap";

/** How a wrapper selects the session when the worker starts (E6, POC PLAN.md P1.5). */
export const SELECTIONS = ["extension-import", "app-import", "fetch-import", "sync-xhr"] as const;

export type Selection = (typeof SELECTIONS)[number];

/** The web-accessible file a session rule redirects to the active slot; unredirected, it throws. */
export const CURRENT_FILE = "ns/current.js";
/** The page bootstrap, which installs the marker a slot file set (src/entrypoints/route-c.ts). */
const PAGE_BOOTSTRAP_FILE = "route-c.js";
/** A path on the worker's own origin that a session rule redirects to the active slot. */
export const REDIRECTED_PATH = "/recnrun/current.js";
/** A path on the worker's own origin that Route B fulfills with the bootstrap of the armed marker. */
const FETCHED_PATH = "/recnrun/fetched.js";
export const FETCHED_PATTERN = `*${FETCHED_PATH}*`;

const quoted = (urls: string[]) => urls.map((url) => JSON.stringify(url)).join(", ");

/** The marker a slot file sets, read from the response; an empty marker makes the bootstrap throw. */
function syncXhr(): string {
  return [
    "(function () {",
    "  var request = new XMLHttpRequest();",
    `  request.open("GET", ${JSON.stringify(REDIRECTED_PATH)}, false);`,
    "  request.send();",
    '  var found = /__recnrunMarker = "([\\w-]+)"/.exec(request.responseText);',
    `  (${BOOTSTRAP_SOURCE})({ marker: found ? found[1] : "" });`,
    "})();",
  ].join("\n");
}

/** The script with a first statement that resolves the session at run time; it never names one. */
export function selectionWrapper(selection: Selection, body: string, origin: string): string {
  const bootstrap = `${origin}${PAGE_BOOTSTRAP_FILE}`;
  switch (selection) {
    case "extension-import":
      return `importScripts(${quoted([`${origin}${CURRENT_FILE}`, bootstrap])});\n${body}`;
    case "app-import":
      return `importScripts(${quoted([REDIRECTED_PATH, bootstrap])});\n${body}`;
    case "fetch-import":
      return `importScripts(${quoted([FETCHED_PATH])});\n${body}`;
    case "sync-xhr":
      return `${syncXhr()}\n${body}`;
  }
}

/** What Route B answers for FETCHED_PATH: the bootstrap of the marker armed when Chrome fetched it. */
export function fetchedSelection(marker: string): string {
  return `${withMarker(marker)};\n`;
}

export function isFetchedSelection(url: string): boolean {
  return URL.canParse(url) && new URL(url).pathname === FETCHED_PATH;
}
