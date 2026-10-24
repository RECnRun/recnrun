const PRODUCTION_MATCHES = ["https://recnrun.com/*"];
const LOCAL_MATCHES = ["http://localhost/*", "http://127.0.0.1/*"];
const LOCAL_MODES = new Set(["development", "test"]);

/** Local origins are trusted only in development and test builds, never in a published one. */
export function contentScriptMatches(mode: string): string[] {
  return LOCAL_MODES.has(mode) ? [...PRODUCTION_MATCHES, ...LOCAL_MATCHES] : PRODUCTION_MATCHES;
}

/** The privacy policy stays readable: the store links to it, and the dashboard would cover it. */
export function contentScriptExcludes(mode: string): string[] {
  return contentScriptMatches(mode).map((pattern) => pattern.replace(/\*$/, "privacy/*"));
}

/** Whether an origin is covered by a `scheme://host/*` match pattern, which ignores the port. */
function originMatches(origin: string, pattern: string): boolean {
  const target = URL.parse(origin);
  const allowed = URL.parse(pattern.replace(/\*$/, ""));
  if (!target || !allowed) return false;
  return target.protocol === allowed.protocol && target.hostname === allowed.hostname;
}

/** The pages allowed to embed the dashboard are exactly the pages the content script runs on. */
export function isAllowedEmbedder(origin: string, mode: string): boolean {
  return contentScriptMatches(mode).some((pattern) => originMatches(origin, pattern));
}

/** The first ancestor frame that is not an allowed site, so a framing page cannot clickjack. */
export function disallowedAncestor(ancestors: readonly string[], mode: string): string | undefined {
  return ancestors.find((origin) => !isAllowedEmbedder(origin, mode));
}

/** The cross-profile POC runs only in development and test builds, never in a published one. */
export const peersEnabled = (mode: string) => LOCAL_MODES.has(mode);
