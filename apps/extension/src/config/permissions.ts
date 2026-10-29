/**
 * What every build asks for. The recorder: `tabs` lists the tabs to record, `storage` keeps the
 * recordings. The Incognito workspace: tab-scoped session rules for the bootstrap barrier, the
 * runtime-registered origin agent, the managed tab's cookie store, the bootstrap commit, and room
 * for identity captures past the default extension quota.
 */
const PERMISSIONS = [
  "storage",
  "tabs",
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
export const WEB_HOSTS = ["http://*/*", "https://*/*"];

/** The manifest keys that grant RECnRun its access, the same in every build. */
export const MANIFEST_ACCESS = {
  permissions: PERMISSIONS,
  host_permissions: WEB_HOSTS,
  // Agent and background exchange Date, Blob, and ArrayBuffer values (Chrome 148+).
  message_serialization: "structured_clone",
} as const;
