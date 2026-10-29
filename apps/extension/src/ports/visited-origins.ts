/**
 * The origins the managed window's identity visited, per window generation: a capture saves each
 * one's site data, since all Incognito tabs share one profile's storage.
 */
export interface VisitedOrigins {
  /** Adds origins not yet kept, in the order first seen; a new generation starts a new list. */
  note: (generation: number, origins: readonly string[]) => Promise<void>;
  /** The origins `generation` visited; none when the list belongs to another generation. */
  visited: (generation: number) => Promise<string[]>;
}
