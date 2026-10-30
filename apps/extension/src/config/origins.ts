const PRODUCTION_MATCHES = ["https://recnrun.com/*"];
const LOCAL_MATCHES = ["http://localhost/*", "http://127.0.0.1/*"];
const LOCAL_MODES = new Set(["development", "test"]);

function withLocal(mode: string): string[] {
  return LOCAL_MODES.has(mode) ? [...PRODUCTION_MATCHES, ...LOCAL_MATCHES] : PRODUCTION_MATCHES;
}

/** Local origins are trusted only in development and test builds, never in a published one. */
export function contentScriptMatches(mode: string): string[] {
  return withLocal(mode);
}

/** Pages that may call the public API with `chrome.runtime.sendMessage(extensionId, …)`. */
export function externalMatches(mode: string): string[] {
  return withLocal(mode);
}

/**
 * Origins the recorder may run on without asking. WXT turns these into install-time host
 * permissions, so only the test build has any: Playwright cannot accept Chrome's permission prompt.
 */
export function recorderMatches(mode: string): string[] {
  return mode === "test" ? LOCAL_MATCHES : [];
}

/** Where the popup's dashboard link goes: the dev server in development, else recnrun.com. */
export function dashboardUrl(mode: string): string {
  return mode === "development" ? "http://localhost:5173/" : "https://recnrun.com/";
}
