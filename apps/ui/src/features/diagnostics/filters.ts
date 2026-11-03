import type { Event } from "@recnrun/protocol";
import type { Api } from "@/api/api";
import type { Params } from "@/api/commands";

/** Which events the timeline keeps by coverage: all, only what was observed, or only gaps. */
export type Coverage = "all" | "observed" | "gaps";

export interface Filters {
  profile: string;
  stepId: string;
  origin: string;
  category: string;
  coverage: Coverage;
}

export const NO_FILTERS: Filters = {
  profile: "",
  stepId: "",
  origin: "",
  category: "",
  coverage: "all",
};

export const PAGE_SIZE = 100;

type Query = Params<"run.queryEvents">;
type Category = NonNullable<Query["category"]>;

const given = <K extends string>(key: K, value: string) => {
  const trimmed = value.trim();
  return trimmed ? ({ [key]: trimmed } as Record<K, string>) : {};
};

/** The `run.queryEvents` params of one timeline page; gaps-only overrides the category. */
export function queryOf(runId: string, filters: Filters, cursor?: string): Query {
  const category = filters.coverage === "gaps" ? "gap" : filters.category;
  return {
    runId,
    limit: PAGE_SIZE,
    ...given("profile", filters.profile),
    ...given("stepId", filters.stepId),
    ...given("origin", filters.origin),
    ...(given("category", category) as { category?: Category }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** Observed-only hides gaps here, since the service query cannot exclude a category. */
export const shownBy =
  ({ coverage }: Filters) =>
  (event: Event): boolean =>
    coverage !== "observed" || event.category !== "gap";

/** Every event of the run that `query` matches, following the journal's cursor to its end. */
export async function allEvents(api: Api, query: Omit<Query, "cursor" | "limit">) {
  const events: Event[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.call("run.queryEvents", {
      ...query,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return events;
}
