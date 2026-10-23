import type { Recording, Snapshot } from "@recnrun/domain";
import { browser } from "wxt/browser";
import { openDashboard } from "@/background/open-dashboard";
import type { DashboardDisposition } from "@/background/open-dashboard";
import { nameMatchIndex, recordingRoute, searchRoute } from "@/dashboard/route";

const MAX_SUGGESTIONS = 5;
const RECORDING_PREFIX = "rec:";
const OPEN_DASHBOARD = "Open the RECnRun dashboard";
const XML_ENTITIES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&apos;",
};

export interface OmniboxSuggestion {
  content: string;
  description: string;
}

export interface OmniboxResult {
  defaultDescription: string;
  suggestions: OmniboxSuggestion[];
}

/** Omnibox descriptions are XML, so every piece of user or stored text is escaped. */
export function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (char) => XML_ENTITIES[char] ?? char);
}

function highlightName(name: string, query: string): string {
  const start = nameMatchIndex(name, query);
  if (query === "" || start < 0) return escapeXml(name);
  const end = start + query.length;
  return `${escapeXml(name.slice(0, start))}<match>${escapeXml(name.slice(start, end))}</match>${escapeXml(name.slice(end))}`;
}

function describe(recording: Recording, query: string): string {
  const events = recording.eventCount === 1 ? "1 event" : `${recording.eventCount} events`;
  return `${highlightName(recording.name, query)} <dim>· ${events}</dim> <url>${escapeXml(recording.startUrl)}</url>`;
}

/** Newest matching recordings first, as omnibox suggestions. */
export function suggestRecordings(recordings: readonly Recording[], text: string): OmniboxResult {
  const query = text.trim();
  const suggestions = recordings
    .filter((recording) => nameMatchIndex(recording.name, query) >= 0)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, MAX_SUGGESTIONS)
    .map((recording) => ({
      content: `${RECORDING_PREFIX}${recording.id}`,
      description: describe(recording, query),
    }));
  const defaultDescription =
    query === ""
      ? OPEN_DASHBOARD
      : `Search RECnRun recordings for <match>${escapeXml(query)}</match>`;
  return { defaultDescription, suggestions };
}

/** The dashboard route for what the user entered: a chosen suggestion, a search, or nothing. */
export function routeForInput(text: string): string {
  const query = text.trim();
  if (query.startsWith(RECORDING_PREFIX)) {
    return recordingRoute(query.slice(RECORDING_PREFIX.length));
  }
  return query === "" ? "" : searchRoute(query);
}

export function createOmniboxHandlers(readSnapshot: () => Promise<Snapshot>) {
  return {
    async inputChanged(text: string): Promise<OmniboxResult> {
      const recordings = await readSnapshot().then(
        (snapshot) => snapshot.recordings,
        () => [],
      );
      return suggestRecordings(recordings, text);
    },
    inputEntered(text: string, disposition: DashboardDisposition): Promise<void> {
      return openDashboard({ route: routeForInput(text), disposition });
    },
  };
}

type OmniboxHandlers = ReturnType<typeof createOmniboxHandlers>;

/** Call synchronously at service worker start, so Chrome finds the listeners after a restart. */
export function registerOmnibox(handlers: OmniboxHandlers): void {
  browser.omnibox.onInputStarted.addListener(() => {
    void browser.omnibox.setDefaultSuggestion({ description: OPEN_DASHBOARD });
  });
  browser.omnibox.onInputChanged.addListener((text, suggest) => {
    void handlers.inputChanged(text).then(({ defaultDescription, suggestions }) => {
      void browser.omnibox.setDefaultSuggestion({ description: defaultDescription });
      suggest(suggestions);
    });
  });
  browser.omnibox.onInputEntered.addListener((text, disposition) => {
    void handlers.inputEntered(text, disposition);
  });
}
