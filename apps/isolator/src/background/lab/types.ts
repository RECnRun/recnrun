import type { DebuggerApi, TargetInfo } from "@/background/probes/types";
import type { RouteAJournal } from "@/background/route-a/types";
import type { RouteBJournal } from "@/background/route-b/types";
import type { SelectionApis } from "@/background/selection/types";

/** One isolated-world injection that returns the page's `#report` text. */
/** What the lab reads inside a page: its report text and its origin's IndexedDB names. */
export interface PageView {
  report: string | null;
  databases: string[] | { error: string };
}

export interface ReportInjection {
  target: { tabId: number };
  world: "ISOLATED";
  func: (waitMs: number) => Promise<PageView>;
  args: [number];
}

/** The `chrome.*` APIs the strict lab uses; unit tests pass fakes. */
export interface LabApis {
  debugger: DebuggerApi;
  /** `chrome.storage.managed`, which only a policy writes. */
  managed: { get(): Promise<Record<string, unknown>> };
  scripting: { executeScript(injection: ReportInjection): Promise<{ result?: unknown }[]> };
  selection: SelectionApis;
  extensionOrigin: string;
  id: string;
  version: string;
  /** POSTs `body` as JSON; the schema keeps `url` under `http://*.localhost`. */
  post(url: string, body: unknown): Promise<void>;
}

/** A tab the lab armed once it had loaded a page of the configured origin. */
export interface ArmedTab {
  tabId: number;
  url: string;
  marker: string;
  route: "a" | "b";
  at: number;
  /** The origin `Storage.clearDataForOrigin` cleared right after arming. */
  cleared?: string;
  /** Chrome's exact error for the first step that failed; the tab then runs unarmed. */
  error?: string;
}

/** What one loaded page of an armed tab reported and what its origin's storage held after it. */
export interface PageRecord {
  tabId: number;
  url: string;
  marker: string;
  at: number;
  /** The page's own `#report` text, `null` for a page without one. */
  report: string | null;
  /** Physical names, read through the tab's debugger session, or Chrome's error. */
  indexedDB: string[] | { error: string };
  cacheStorage: string[] | { error: string };
}

/** One lab command from the managed value and what it did. */
export interface CommandRecord {
  key: string;
  at: number;
  result: unknown;
}

export interface LabLoaded {
  event: "loaded";
  id: string;
  version: string;
  /** `performance.timeOrigin` of this background: a new value means it started again. */
  timeOrigin: number;
  /** `chrome.debugger.getTargets()` before the lab armed anything; `attached` says another client held one. */
  targets: TargetInfo[];
}

export interface LabJournal {
  event: "journal";
  seq: number;
  id: string;
  timeOrigin: number;
  targetsAtStart: TargetInfo[];
  /** `getTargets()` at this post. */
  targets: TargetInfo[];
  armed: ArmedTab[];
  routeA: RouteAJournal;
  routeB: RouteBJournal;
  pages: PageRecord[];
  commands: CommandRecord[];
  errors: string[];
}
