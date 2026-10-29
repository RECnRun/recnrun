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

/**
 * Every http(s) host: an identity keeps its whole Incognito cookie store, whatever site set it, and
 * `cookies.getAll` lists a cookie only with access to its domain (`cookies_helpers.cc:51-56`).
 */
const WEB_HOSTS = ["http://*/*", "https://*/*"];

/** The manifest keys that differ between a published build and the POC's local builds. */
export interface BuildAccess {
  permissions: string[];
  host_permissions?: string[];
  message_serialization?: "structured_clone";
}

/** Published builds keep only the product's permissions; local builds add the POC's set. */
export function buildAccess(mode: string): BuildAccess {
  if (!POC_MODES.has(mode)) return { permissions: PRODUCT_PERMISSIONS };
  return {
    permissions: [...PRODUCT_PERMISSIONS, ...POC_PERMISSIONS],
    host_permissions: WEB_HOSTS,
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
