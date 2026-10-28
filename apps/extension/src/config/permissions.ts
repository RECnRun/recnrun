const POC_MODES = new Set(["development", "test"]);

/** What every build asks for: `tabs` lists the tabs to record; `storage` keeps the recordings. */
const PRODUCT_PERMISSIONS = ["storage", "tabs"];

/**
 * The Incognito workspace POC (OD-1): tab-scoped session rules for the bootstrap barrier, the
 * runtime-registered origin agent, the managed tab's cookie store, the bootstrap commit, and room
 * for identity captures past the default extension quota.
 */
const POC_PERMISSIONS = [
  "declarativeNetRequest",
  "scripting",
  "cookies",
  "webNavigation",
  "unlimitedStorage",
];

/** The fixture origins of the end-to-end tests (`app.localhost`, `other.localhost`, …). */
// Chrome lists and sets a Secure cookie only with access to its https URL, even on http localhost.
const FIXTURE_HOSTS = ["http://*.localhost/*", "https://*.localhost/*"];

/** The manifest keys that differ between a published build and the POC's local builds. */
export interface BuildAccess {
  permissions: string[];
  host_permissions?: string[];
  message_serialization?: "structured_clone";
}

/** The URL parser's form of an IP address: bracketed IPv6, or four dotted decimal numbers. */
const IP_ADDRESS = /^(\[.*\]|\d+\.\d+\.\d+\.\d+)$/;

/**
 * `hostname` and each parent domain of two labels or more: every domain a cookie set by it can
 * name. Parents above the registrable domain (`co.uk`) are included too, as no public suffix
 * list ships here; Chrome stores no cookie on a public suffix, so they reach no cookie.
 */
function cookieDomains(hostname: string): string[] {
  if (IP_ADDRESS.test(hostname)) return [hostname];
  const labels = hostname.split(".");
  return labels
    .slice(0, Math.max(labels.length - 1, 1))
    .map((_, index) => labels.slice(index).join("."));
}

/**
 * `RECNRUN_POC_HOSTS`, comma-separated `http(s)` origins, as match patterns for each host and the
 * domains its cookies can name. `cookies.getAll` and `cookies.set` need access to a cookie's
 * domain as a URL whose scheme follows its `Secure` attribute alone (`cookies_helpers.cc:51-56,
 * 201-206`, `cookie_util.cc:664-692`), with no port, so each domain gets both schemes, portless.
 */
function pocHostPatterns(pocHosts: string): string[] {
  const hostnames = pocHosts
    .split(",")
    .map((each) => each.trim())
    .filter(Boolean)
    .map((each) => {
      const url = URL.parse(each);
      if (url?.protocol !== "http:" && url?.protocol !== "https:") {
        throw new Error(`RECNRUN_POC_HOSTS lists "${each}", which is not an http(s) origin.`);
      }
      return url.hostname;
    });
  const domains = hostnames.flatMap(cookieDomains);
  return [...new Set(domains.flatMap((domain) => [`https://${domain}/*`, `http://${domain}/*`]))];
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
