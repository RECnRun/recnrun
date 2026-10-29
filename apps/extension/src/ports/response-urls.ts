/** Per origin, each restored cache entry's request URL with the URL its response was fetched from. */
export type ResponseUrls = Record<string, [string, string][]>;

/** The response URLs of the managed window's restored cache entries, per window generation. */
export interface ResponseUrlStore {
  /** The URLs `generation`'s start restored; none when another generation's are kept. */
  read: (generation: number) => Promise<ResponseUrls>;
  /** Replaces the kept URLs with `generation`'s. */
  write: (generation: number, urls: ResponseUrls) => Promise<void>;
}
