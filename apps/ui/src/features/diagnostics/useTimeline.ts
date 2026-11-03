import type { Event } from "@recnrun/protocol";
import { useEffect, useState } from "preact/hooks";
import { useApi } from "@/api/context";
import { type ApiError, toApiError } from "@/api/error";
import { type Filters, queryOf, shownBy } from "@/features/diagnostics/filters";

interface Pages {
  events: Event[];
  nextCursor: string | undefined;
  loading: boolean;
  error: ApiError | undefined;
}

const EMPTY: Pages = { events: [], nextCursor: undefined, loading: true, error: undefined };

/** The run's timeline under `filters`, a page at a time; callers key it by its filters to start over. */
export function useTimeline(runId: string, filters: Filters) {
  const api = useApi();
  const [pages, setPages] = useState<Pages>(EMPTY);
  const [cursor, setCursor] = useState<string>();
  useEffect(() => {
    let live = true;
    setPages((current) => ({ ...current, loading: true, error: undefined }));
    api.call("run.queryEvents", queryOf(runId, filters, cursor)).then(
      ({ events, nextCursor }) =>
        live &&
        setPages((current) => ({
          events: [...current.events, ...events.filter(shownBy(filters))],
          nextCursor,
          loading: false,
          error: undefined,
        })),
      (error: unknown) =>
        live && setPages((current) => ({ ...current, loading: false, error: toApiError(error) })),
    );
    return () => {
      live = false;
    };
  }, [api, runId, filters, cursor]);
  const more = pages.nextCursor;
  return { ...pages, loadMore: more ? () => setCursor(more) : undefined };
}
