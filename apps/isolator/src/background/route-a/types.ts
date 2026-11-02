/** One target Route A attached: by auto-attach from the armed tab, or directly by id. */
export interface JournalEntry {
  /** The flattened session of the target; empty for a target attached directly by id. */
  sessionId: string;
  /** The session whose auto-attach reported the target; absent for the tab's own session. */
  parentSessionId?: string;
  targetId: string;
  type: string;
  url: string;
  waitingForDebugger: boolean;
  /** `performance.now()` when the extension learned of the target. */
  attachedAt: number;
  /** The marker evaluated in the target; absent for targets that are not workers. */
  marker?: string;
  /** Milliseconds from learning of the target to the bootstrap's evaluation resolving. */
  bootstrapMs?: number;
  /** What the bootstrap returned in the target. */
  installed?: unknown;
  /** `ok`, or Chrome's error text for `Target.setAutoAttach` on the target's session. */
  autoAttach?: string;
  released: boolean;
  /** Chrome's exact error or exception text for the first step that failed. */
  error?: string;
}

/** A worker target that existed on the tab's origin but that Route A never attached. */
export interface UnattachedTarget {
  targetId: string;
  type: string;
  url: string;
}

export interface RouteAJournal {
  marker?: string;
  bootstrap: { hash: string; version: string };
  entries: JournalEntry[];
  unattached: UnattachedTarget[];
}

/** What the harness reaches with `Runtime.evaluate` in the isolator's service worker (E2, E3). */
export interface RouteA {
  /** Sets the marker the next bootstraps carry and returns it. */
  setMarker(marker: unknown): string;
  /** Attaches to the tab and auto-attaches its targets, paused, before they run. */
  arm(request: unknown): Promise<void>;
  /** The journal once every target attached so far is handled. */
  journal(): Promise<RouteAJournal>;
  /** Detaches the tab and every direct target, then returns and clears the journal. */
  disarm(request: unknown): Promise<RouteAJournal>;
  /** Attaches one target by id and evaluates the bootstrap in it. */
  attachTarget(request: unknown): Promise<JournalEntry>;
  /** Clears the service workers, IndexedDB, and Cache Storage of the tab's origin. */
  clearOrigin(request: unknown): Promise<{ origin: string }>;
  /** The open tabs, so the harness can name the one it drives. */
  tabs(): Promise<{ tabId: number; url: string }[]>;
}
