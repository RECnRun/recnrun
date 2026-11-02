// Shared by /sw.js and the service-worker route.

export const CACHE_NAME = "recnrun-fixture-v1";

/** The only path the worker answers; it serves it from Cache Storage after the first fetch. */
export const CACHED_PATH = "/api/cacheable";

/** Response header the worker sets to `network` or `cache`. */
export const SOURCE_HEADER = "X-Fixture-Source";
