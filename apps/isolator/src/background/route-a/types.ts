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
  /** Milliseconds from learning of the target to `chrome.debugger.attach` resolving (watch). */
  attachMs?: number;
  /** The pause-before-script sequence, when the tab was armed with `pauseBeforeScript`. */
  pause?: PauseRecord;
}

/** One command or event of the pause-before-script sequence. */
export interface PauseStep {
  step: string;
  /** `ok`, what the event said, or Chrome's exact error text. */
  result: string;
}

export interface PauseRecord {
  steps: PauseStep[];
  /** Whether a `Debugger.paused` with reason `instrumentation` arrived. */
  paused: boolean;
  /** What `Debugger.setInstrumentationBreakpoint` answered, removed at the first pause. */
  breakpointId?: string;
  /** Milliseconds from learning of the target to that pause. */
  pausedMs?: number;
  /** `typeof caches` and `typeof CacheStorage` at that pause. */
  typeofAtPause?: unknown;
  /** Pauses after the first, each resumed at once. */
  laterPauses: number;
}

/** What `watch` saw and attached between `watch` and `unwatch`. */
export interface WatchReport {
  origin: string;
  marker: string;
  /** Milliseconds between two `chrome.debugger.getTargets()` polls. */
  intervalMs: number;
  /** Worker targets of the origin already listed at `watch`, which it never attached. */
  staleSkipped: number;
  polls: number;
  /** Chrome's exact errors for polls that failed. */
  pollErrors: string[];
  entries: JournalEntry[];
}

/** What closing a target through its own debugger session did. */
export interface CloseReport {
  targetId: string;
  /** `ok` or Chrome's exact error, per step; `not sent` after a failed attach. */
  attach: string;
  close: string;
  detach: string;
  /** Whether `getTargets()` still listed the target right after. */
  listedAfter: boolean;
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
  /**
   * Attaches to the tab and auto-attaches its targets, paused, before they run. With
   * `pauseBeforeScript`, a waiting worker is bootstrapped at its first instrumentation pause instead.
   */
  arm(request: unknown): Promise<void>;
  /** Polls `getTargets()` and attaches, by id, each new worker target of a loopback origin. */
  watch(request: unknown): Promise<{ intervalMs: number; staleSkipped: number }>;
  /** Stops polling, detaches what `watch` attached, and returns what it saw. */
  unwatch(): Promise<WatchReport>;
  /** Attaches to a target by id and sends `Target.closeTarget` on its own session. */
  closeTarget(request: unknown): Promise<CloseReport>;
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
