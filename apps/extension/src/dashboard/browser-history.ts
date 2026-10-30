import { browser } from "wxt/browser";
import type { HistoryEntry, HistorySource } from "@/ports/history";

/** The most history entries one search returns. */
export const HISTORY_RESULTS = 20;

/**
 * The normal profile's history through Chrome; the dashboard runs in the normal context, so it never
 * sees Incognito visits, which Chrome does not record. The entries stay in the dashboard's memory.
 */
export const browserHistory: HistorySource = {
  search: async (text) => {
    // Without startTime Chrome searches only the last day (history_api.cc:309, 317-319).
    const items = await browser.history.search({ text, startTime: 0, maxResults: HISTORY_RESULTS });
    return items.flatMap(({ url, title, lastVisitTime }): HistoryEntry[] => {
      if (url === undefined) return [];
      const entry = { url, title: title || url };
      return [lastVisitTime === undefined ? entry : { ...entry, lastVisitTime }];
    });
  },
};
