/** One origin the managed window's identity visited, as the next capture reads it. */
export interface Visit {
  origin: string;
  /** The last page an identity's own tab showed there, without its query or fragment. */
  url?: string;
  /** Set when a start could not restore the origin: the next capture keeps its last saved storage. */
  carry?: boolean;
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
}
