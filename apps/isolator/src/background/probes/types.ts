/** What `chrome.debugger` allowed for one probe (PLAN.md P0.4). */
export type ProbeStatus = "allowed" | "rejected" | "unavailable";

export interface ProbeResult {
  id: string;
  status: ProbeStatus;
  /** Chrome's exact error text, or what was missing for `unavailable`. */
  error?: string;
  detail?: unknown;
}

export interface Debuggee {
  tabId?: number;
  targetId?: string;
  /** A flattened child session inside the root debuggee (Chrome 125+). */
  sessionId?: string;
}

export interface TargetInfo {
  type: string;
  id: string;
  url: string;
  attached: boolean;
  tabId?: number;
}

interface EventLike<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

export type EventListener = (source: Debuggee, method: string, params?: object) => void;
export type DetachListener = (source: Debuggee, reason: string) => void;

/** The part of `chrome.debugger` the probes use; unit tests pass a fake. */
export interface DebuggerApi {
  getTargets(): Promise<TargetInfo[]>;
  attach(target: Debuggee, requiredVersion: string): Promise<void>;
  detach(target: Debuggee): Promise<void>;
  sendCommand(
    target: Debuggee,
    method: string,
    params?: { [key: string]: unknown },
  ): Promise<object | undefined>;
  onEvent: EventLike<EventListener>;
  onDetach: EventLike<DetachListener>;
}

/** Fixture URLs the harness passes in; the extension's source never names a fixture host. */
export interface ProbeTargets {
  /** The page that owns the dedicated and shared workers, also the tab the probes attach to. */
  pageUrl: string;
  serviceWorkerUrl: string;
  sharedWorkerUrl: string;
  dedicatedWorkerUrl: string;
  /** A cross-site page the auto-attach probe loads in an iframe. */
  iframeUrl: string;
  /** The origin `Network.setCookie` writes a throwaway cookie on. */
  cookieUrl: string;
}

export type AutoAttachPhase = "existing" | "after-reload";

export interface AutoAttached {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  waitingForDebugger: boolean;
  /** Whether the target already existed when auto-attach was set, or came with the reload. */
  phase: AutoAttachPhase;
  /** `ok` or the error of `Runtime.runIfWaitingForDebugger`. */
  released?: string;
}

/** State one probe leaves for the next ones in the same run. */
export interface ProbeState {
  targets: TargetInfo[];
  tabId?: number;
  tabAttached: boolean;
  autoAttachSet: boolean;
  autoAttachPhase: AutoAttachPhase;
  autoAttached: AutoAttached[];
  attached: Debuggee[];
  detaches: { source: Debuggee; reason: string }[];
  serviceWorkerSession?: Debuggee;
}

export interface ProbeContext {
  api: DebuggerApi;
  urls: ProbeTargets;
  state: ProbeState;
  /** Waits, so tests can run the window-based probes without real time. */
  wait(ms: number): Promise<void>;
}

/** A probe returns its outcome without its id; the runner adds the id. */
export type ProbeOutcome = Omit<ProbeResult, "id">;

export interface ProbeDefinition {
  id: string;
  description: string;
  run(context: ProbeContext): Promise<ProbeOutcome>;
}
