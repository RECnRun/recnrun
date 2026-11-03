import type { DebuggerApi } from "@/background/probes/types";

/** The rule shape `declarativeNetRequest` session rules take, as far as E6 reads them. */
export interface SessionRule {
  id: number;
  priority?: number;
  action: object;
  condition: object;
}

/** The redirect rule E6 adds: one URL to one slot file. */
export interface RedirectRule extends SessionRule {
  priority: number;
  action: { type: "redirect"; redirect: { extensionPath: string } };
  condition: { urlFilter: string };
}

/** The `chrome.*` APIs the selection uses; unit tests pass fakes. */
export interface SelectionApis {
  debugger: DebuggerApi;
  dnr: {
    updateSessionRules(update: {
      addRules?: RedirectRule[];
      removeRuleIds?: number[];
    }): Promise<void>;
    getSessionRules(): Promise<SessionRule[]>;
  };
  /** `chrome.storage.session`, which outlives a suspended background but not a browser restart. */
  storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  /** `chrome-extension://<id>/`. */
  extensionOrigin: string;
}

export interface SelectionOptions {
  now?: () => number;
  /** `performance.timeOrigin` of this background: a new value means the worker started again. */
  timeOrigin?: number;
  /** Runs the self-close after the harness's evaluation returned. */
  schedule?: (task: () => Promise<void>) => void;
}

export interface Selected {
  slot: number;
  file: string;
  ruleIds: number[];
  /** The selection's rules the update replaced. */
  removed: number[];
  /** Milliseconds `updateSessionRules` took to resolve. */
  updateMs: number;
}

export interface SuspendRecord {
  targetId: string;
  timeOrigin: number;
  requestedAt: number;
  /** `ok` or Chrome's exact error for attaching to the background's own target. */
  attach?: string;
  /** Chrome's exact error for `Target.closeTarget`; on success the background stops before it can write. */
  close?: string;
}

export interface SelectionStatus {
  timeOrigin: number;
  wakes: { event: string; at: number }[];
  suspend: SuspendRecord | null;
  ruleIds: number[];
}

/** What the harness reaches with `Runtime.evaluate` in the isolator's service worker (E6). */
export interface Selection {
  /** Points `ns/current.js` and each origin's `/recnrun/current.js` at slot `slot`. */
  select(request: unknown): Promise<Selected>;
  clear(): Promise<{ removed: number[] }>;
  rules(): Promise<SessionRule[]>;
  /** Closes this background's own worker target, as Chrome's idle timeout would stop it. */
  suspend(): Promise<{ targetId: string; timeOrigin: number }>;
  status(): Promise<SelectionStatus>;
}
