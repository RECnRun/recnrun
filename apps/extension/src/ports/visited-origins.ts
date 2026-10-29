/** One origin the managed window's identity visited, as the next capture reads it. */
export interface Visit {
  origin: string;
  /** The last page an identity's own tab showed there, without its query or fragment. */
  url?: string;
  /** Set when a start could not restore the origin: the next capture keeps its last saved storage. */
  carry?: boolean;
}

/** A tab's place in the capture a start reopened it from: its window and its index there. */
export interface LayoutPlace {
  window: number;
  tab: number;
}

/** The origins one tab visited, whose sessionStorage belongs to that tab alone. */
export interface TabVisits {
  tabId: number;
  /** Set when a start reopened the tab: a carried origin's entries come from that place. */
  from?: LayoutPlace;
  visits: Visit[];
}

/**
 * The origins the managed window's identity visited, per window generation: a capture saves each
 * one's site data, since all Incognito tabs share one profile's storage.
 */
export interface VisitedOrigins {
  /**
   * Adds origins not yet kept, in the order first seen, and updates those kept: a newer page
   * replaces the last one, and a visit without `carry` clears it. A new generation starts a new list.
   */
  note: (generation: number, visits: readonly Visit[]) => Promise<void>;
  /** The visits of `generation`; none when the list belongs to another generation. */
  visited: (generation: number) => Promise<Visit[]>;
  /** Notes `visits` for one tab as `note` does for the list, and where a start reopened it from. */
  noteTab: (
    generation: number,
    tabId: number,
    visits: readonly Visit[],
    from?: LayoutPlace,
  ) => Promise<void>;
  /** Moves `removed`'s visits and place to `added`, the id Chrome gave the tab when it swapped its contents. */
  replaceTab: (generation: number, removed: number, added: number) => Promise<void>;
  /** Each tab's visits in `generation`; none when the lists belong to another generation. */
  tabVisits: (generation: number) => Promise<TabVisits[]>;
  /** Keeps `windowId` as the Incognito window of `generation` that had the focus last. */
  noteFocus: (generation: number, windowId: number) => Promise<void>;
  /** The Incognito window of `generation` that had the focus last, if one did. */
  focusedWindow: (generation: number) => Promise<number | undefined>;
}
