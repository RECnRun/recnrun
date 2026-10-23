/** What the dashboard shows, read from the hash so links work across page loads and tabs. */
export type DashboardRoute =
  | { view: "all" }
  | { view: "recording"; id: string }
  | { view: "search"; query: string };

const RECORDING = "/recordings/";
const SEARCH = "/search/";

export function recordingRoute(id: string): string {
  return `${RECORDING}${encodeURIComponent(id)}`;
}

export function searchRoute(query: string): string {
  return `${SEARCH}${encodeURIComponent(query)}`;
}

export function parseRoute(hash: string): DashboardRoute {
  const path = hash.replace(/^#/, "");
  try {
    if (path.startsWith(RECORDING)) {
      return { view: "recording", id: decodeURIComponent(path.slice(RECORDING.length)) };
    }
    if (path.startsWith(SEARCH)) {
      return { view: "search", query: decodeURIComponent(path.slice(SEARCH.length)) };
    }
  } catch {
    // A malformed escape sequence falls back to the full list.
  }
  return { view: "all" };
}

/** Position of the query in the name, ignoring case, or -1. */
export function nameMatchIndex(name: string, query: string): number {
  return name.toLowerCase().indexOf(query.toLowerCase());
}
