import { isAllowedTarget } from "@recnrun/domain";
import type { Identity } from "@recnrun/domain";
import type { HistoryEntry } from "@/ports/history";
import type { OpenTab } from "@/ports/tabs";

/** Where a suggested address comes from, which the list shows next to it. */
type SuggestionSource = "tab" | "identity" | "history";

export interface AddressSuggestion {
  url: string;
  title: string;
  from: SuggestionSource;
}

export interface SuggestionSources {
  tabs: readonly OpenTab[];
  identities: readonly Identity[];
  history: readonly HistoryEntry[];
}

/** The longest list the Address field shows. */
export const MAX_SUGGESTIONS = 20;

const matches = (query: string, { url, title }: AddressSuggestion) =>
  url.toLowerCase().includes(query) || title.toLowerCase().includes(query);

/**
 * What the Address field offers for `text`: open normal tabs, then saved identities, both matched
 * here, then history, which Chrome already matched, most recent visit first. Only http(s)
 * addresses, each once.
 */
export function addressSuggestions(text: string, sources: SuggestionSources): AddressSuggestion[] {
  const query = text.trim().toLowerCase();
  const local: AddressSuggestion[] = [
    ...sources.tabs
      .filter((tab) => !tab.incognito)
      .map(({ url, title }) => ({ url, title, from: "tab" as const })),
    ...sources.identities.map(({ url, label }) => ({
      url,
      title: label,
      from: "identity" as const,
    })),
  ].filter((each) => matches(query, each));
  const history = [...sources.history]
    .sort((a, b) => (b.lastVisitTime ?? 0) - (a.lastVisitTime ?? 0))
    .map(({ url, title }) => ({ url, title, from: "history" as const }));
  const unique = new Map<string, AddressSuggestion>();
  for (const each of [...local, ...history]) {
    if (isAllowedTarget(each.url) && !unique.has(each.url)) unique.set(each.url, each);
  }
  return [...unique.values()].slice(0, MAX_SUGGESTIONS);
}
