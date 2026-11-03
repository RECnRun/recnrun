/** The fields of a `chrome.scripting` registration Route C sets or reads back. */
export interface ContentScript {
  id: string;
  matches?: string[];
  js?: string[];
  runAt?: "document_start" | "document_end" | "document_idle";
  world?: "ISOLATED" | "MAIN";
  allFrames?: boolean;
  matchOriginAsFallback?: boolean;
  persistAcrossSessions?: boolean;
}

/** The part of `chrome.scripting` Route C uses, so tests pass a fake. */
export interface ScriptingApi {
  registerContentScripts(scripts: ContentScript[]): Promise<void>;
  updateContentScripts(scripts: ContentScript[]): Promise<void>;
  unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
  getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<ContentScript[]>;
}

/** What the harness reaches with `Runtime.evaluate` in the isolator's service worker (E7). */
export interface RouteC {
  /** Registers the page bootstrap for `{ marker, matches?, workers? }`; returns the slot marker pages get. */
  install(request: unknown): Promise<string>;
  /** Points the registration at the next slot for `{ marker }`; returns that slot's marker. */
  setMarker(request: unknown): Promise<string>;
  /** Removes the registration. */
  uninstall(): Promise<void>;
  /** The registration as Chrome reports it. */
  registered(): Promise<ContentScript[]>;
}
