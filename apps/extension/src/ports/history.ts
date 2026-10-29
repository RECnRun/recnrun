/** A page of the normal profile's history, as Chrome lists it; never stored by RECnRun. */
export interface HistoryEntry {
  url: string;
  title: string;
  /** Milliseconds since the epoch; Chrome omits it for a page it never recorded a visit to. */
  lastVisitTime?: number;
}

/** The normal profile's history, searched as the user types; injected so tests need no history API. */
export interface HistorySource {
  search: (text: string) => Promise<HistoryEntry[]>;
}
