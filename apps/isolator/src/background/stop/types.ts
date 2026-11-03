import type { Debuggee, DebuggerApi } from "@/background/probes/types";

/** One `chrome.*` call a mechanism made, timed with `performance.now()` (POC PLAN.md P1.3). */
export interface StopCall {
  api: "debugger" | "declarativeNetRequest" | "tabs";
  method: string;
  target?: Debuggee;
  params?: Record<string, unknown>;
  startedAt: number;
  endedAt: number;
  result?: unknown;
  /** Chrome's exact error text, or the bound the call did not answer within. */
  error?: string;
}

/** What one mechanism call did; `timeOrigin` turns the timestamps into wall-clock time. */
export interface StopJournal {
  mechanism: string;
  timeOrigin: number;
  startedAt: number;
  endedAt: number;
  calls: StopCall[];
  outcome: Record<string, unknown>;
}

/** An event the watcher saw, with what it did about a worker that restarted under a session. */
export interface WatchEvent {
  at: number;
  method: string;
  source: Debuggee;
  params?: unknown;
  bootstrap?: { installed?: unknown; error?: string };
  released?: string;
}

export interface WatchJournal {
  timeOrigin: number;
  marker?: string;
  events: WatchEvent[];
  calls: StopCall[];
}

/** The rule shape `declarativeNetRequest.updateSessionRules` takes, as far as E4 uses it. */
export interface BlockRule {
  id: number;
  priority: number;
  action: { type: "block" };
  condition: { regexFilter: string };
}

/** The part of `chrome.declarativeNetRequest` the stop mechanisms use; unit tests pass a fake. */
export interface DnrApi {
  updateSessionRules(options: { addRules?: BlockRule[]; removeRuleIds?: number[] }): Promise<void>;
  getSessionRules(): Promise<{ id: number }[]>;
}

/** The part of `chrome.tabs` the eviction uses. */
export interface TabsApi {
  query(info: { url: string }): Promise<{ id?: number; url?: string }[]>;
  remove(tabIds: number[]): Promise<void>;
}

export interface StopApis {
  debugger: DebuggerApi;
  dnr: DnrApi;
  tabs: TabsApi;
}

/** What `performance` gives the journals; tests pass a counting clock. */
export interface Clock {
  now(): number;
  timeOrigin: number;
}

/** The `recnrunStop` global the E4 harness calls through `Runtime.evaluate`. */
export interface Stop {
  closeTarget(request: unknown): Promise<StopJournal>;
  terminateExecution(request: unknown): Promise<StopJournal>;
  pauseHold(request: unknown): Promise<StopJournal>;
  release(request: unknown): Promise<StopJournal>;
  blockScope(request: unknown): Promise<StopJournal>;
  unblock(): Promise<StopJournal>;
  unregister(request: unknown): Promise<StopJournal>;
  client(request: unknown): Promise<StopJournal>;
  watch(request: unknown): WatchJournal;
  unwatch(): Promise<WatchJournal>;
}
