import type { Selection } from "@/background/route-b/select";

/** Where Chrome paused a request: the armed tab's own session or a worker's flattened session. */
export type SessionKind = "tab" | "worker";

/** How Route B wrapped a script: the bootstrap prepended, a static import of it first, or an E6 selection. */
export type WrapperKind = "prepend" | "module-import" | Selection;

/** One request Chrome paused through `Fetch.requestPaused` on a session of an armed tab. */
export interface PausedEntry {
  session: SessionKind;
  /** The worker's flattened session; absent on the tab's own session. */
  sessionId?: string;
  url: string;
  /** Chrome's `resourceType` for the request, exactly as it reported it. */
  resourceType: string;
  stage: "request" | "response";
  /**
   * `main` when the request carries `Service-Worker: script`, `imported` for another JavaScript response,
   * `selection` for the E6 selection path Route B answers itself.
   */
  role?: "main" | "imported" | "selection";
  status?: number;
  /** Chrome's `responseErrorReason` when the response failed before Route B saw it. */
  errorReason?: string;
  action: "fulfilled" | "continued" | "failed";
  /** Set on every script Route B fulfilled with a wrapped body. */
  declared?: "transformed";
  wrapper?: WrapperKind;
  /** UTF-8 bytes of the body Chrome returned and of the body Route B fulfilled. */
  originalBytes?: number;
  fulfilledBytes?: number;
  /** `performance.now()` when Chrome paused the request. */
  pausedAt: number;
  /** Milliseconds from the event to Chrome's reply to the command that let the request go. */
  waitedMs?: number;
  /** Chrome's exact error text for the first command that failed. */
  error?: string;
}

/** One target the armed tab's auto-attach reported. */
export interface WorkerEntry {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  waitingForDebugger: boolean;
  attachedAt: number;
  /** `ok`, `skipped`, or Chrome's error text for `Fetch.enable` on the target's session. */
  fetchEnable: string;
  /** `ok`, `skipped`, or Chrome's error text for `Network.enable` on the target's session. */
  networkEnable: string;
  released: boolean;
  error?: string;
}

/** One request a worker made, from the Network events of its session (the `network` diagnostic). */
export interface NetworkEntry {
  sessionId: string;
  requestId: string;
  url?: string;
  /** `clientSecurityState` of `Network.requestWillBeSentExtraInfo`: the worker's address space. */
  initiatorIPAddressSpace?: string;
  requestPolicy?: string;
  /** `Network.loadingFailed`, exactly as Chrome reported it. */
  errorText?: string;
  blockedReason?: string;
  corsError?: string;
}

export interface RouteBJournal {
  bootstrap: { hash: string; version: string };
  /** The marker and the outcome of `Fetch.enable` on each armed tab's own session. */
  tabs: { tabId: number; marker: string; fetchEnable: string }[];
  workers: WorkerEntry[];
  paused: PausedEntry[];
  network: NetworkEntry[];
}

/** What the page's `registration.update()` left, read in the page through the tab's session. */
export interface UpdateOutcome {
  updatefound?: boolean;
  installing?: boolean;
  waiting?: boolean;
  active?: string | null;
  error?: string;
}

/** What the harness reaches with `Runtime.evaluate` in the isolator's service worker (E5). */
export interface RouteB {
  /** Intercepts the tab's and its workers' scripts and wraps them with the bootstrap of `marker`. */
  arm(request: unknown): Promise<{ fetchEnable: string }>;
  /** The journal once every paused request and attached target so far is handled. */
  journal(): Promise<RouteBJournal>;
  /** Detaches the tab, then returns and clears the journal. */
  disarm(request: unknown): Promise<RouteBJournal>;
  /** Calls `registration.update()` in the armed tab's page and reports what it found. */
  update(request: unknown): Promise<UpdateOutcome>;
  /** Closes a worker target through its own session, as E1's `worker-close-target` probe did. */
  stopWorker(request: unknown): Promise<{ success: boolean }>;
}
