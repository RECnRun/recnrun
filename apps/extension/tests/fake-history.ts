import type { HistoryEntry, HistorySource } from "@/ports/history";

/** History that answers every search with `entries`, keeping each searched text. */
export function fakeHistory(entries: HistoryEntry[] = []) {
  const searches: string[] = [];
  const source: HistorySource = {
    search: async (text) => {
      searches.push(text);
      return entries;
    },
  };
  return { source, searches };
}
