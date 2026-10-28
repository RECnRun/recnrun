const POC_MODES = new Set(["development", "test"]);

/** What every build asks for: `tabs` lists the tabs to record; `storage` keeps the recordings. */
const PRODUCT_PERMISSIONS = ["storage", "tabs"];

/**
 * The Incognito workspace POC (OD-1): tab-scoped session rules for the bootstrap barrier, the
 * runtime-registered origin agent, the managed tab's cookie store, and the bootstrap commit.
 */
const POC_PERMISSIONS = ["declarativeNetRequest", "scripting", "cookies", "webNavigation"];

/** The fixture origins of the end-to-end tests (`app.localhost`, `other.localhost`, …). */
const FIXTURE_HOSTS = ["http://*.localhost/*"];

/** The manifest keys that differ between a published build and the POC's local builds. */
export interface BuildAccess {
  permissions: string[];
  host_permissions?: string[];
  message_serialization?: "structured_clone";
}

/** `RECNRUN_POC_HOSTS`, comma-separated `http(s)` origins, as `origin/*` match patterns. */
function pocHostPatterns(pocHosts: string): string[] {
  return pocHosts
    .split(",")
    .map((each) => each.trim())
    .filter(Boolean)
    .map((each) => {
      const url = URL.parse(each);
      if (url?.protocol !== "http:" && url?.protocol !== "https:") {
        throw new Error(`RECNRUN_POC_HOSTS lists "${each}", which is not an http(s) origin.`);
      }
      return `${url.origin}/*`;
    });
}

/** Published builds keep only the product's permissions; local builds add the POC's set. */
export function buildAccess(mode: string, pocHosts = ""): BuildAccess {
  if (!POC_MODES.has(mode)) return { permissions: PRODUCT_PERMISSIONS };
  return {
    permissions: [...PRODUCT_PERMISSIONS, ...POC_PERMISSIONS],
    host_permissions: [...FIXTURE_HOSTS, ...pocHostPatterns(pocHosts)],
    // Agent and background exchange Date, Blob, and ArrayBuffer values (Chrome 148+).
    message_serialization: "structured_clone",
  };
}

/** Entrypoints only the POC registers; a published build lacks `scripting` to ever run them. */
const POC_ENTRYPOINTS = new Set(["origin-agent"]);

/** Whether a build of `mode` leaves the entrypoint `name` out. */
export function skipsEntrypoint(mode: string, name: string): boolean {
  return !POC_MODES.has(mode) && POC_ENTRYPOINTS.has(name);
}
