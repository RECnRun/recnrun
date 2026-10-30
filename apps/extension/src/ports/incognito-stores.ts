/**
 * The ids of every Incognito cookie store Chrome listed to RECnRun, kept across restarts: a closed
 * Incognito profile leaves the listing before Chrome destroys it, so only these ids can be probed.
 */
export interface IncognitoStoreMemory {
  read: () => Promise<string[]>;
  /** Adds ids not yet kept; the order of first sight is kept. */
  remember: (ids: readonly string[]) => Promise<void>;
}
