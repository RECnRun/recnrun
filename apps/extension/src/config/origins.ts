const PRODUCTION_MATCHES = ["https://recnrun.com/*"];
const LOCAL_MATCHES = ["http://localhost/*", "http://127.0.0.1/*"];
const LOCAL_MODES = new Set(["development", "test"]);

/** Local origins are trusted only in development and test builds, never in a published one. */
export function contentScriptMatches(mode: string): string[] {
  return LOCAL_MODES.has(mode) ? [...PRODUCTION_MATCHES, ...LOCAL_MATCHES] : PRODUCTION_MATCHES;
}
