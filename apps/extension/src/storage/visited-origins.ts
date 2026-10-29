import { OriginSchema } from "@recnrun/domain";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";
import type { TabVisits, Visit, VisitedOrigins } from "@/ports/visited-origins";

// Session storage: it outlives a stopped service worker and ends with the browser, as Incognito does.
const visitedItem = storage.defineItem<unknown>("session:visited-origins");

const VisitSchema = v.pipe(
  v.object({
    origin: OriginSchema,
    url: v.optional(v.pipe(v.string(), v.maxLength(2048))),
    carry: v.optional(v.literal(true)),
  }),
  v.check(
    ({ origin, url }) => url === undefined || URL.parse(url)?.origin === origin,
    "A visited page must be on its origin.",
  ),
);

const IndexSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

const TabVisitsSchema = v.object({
  tabId: v.pipe(v.number(), v.integer()),
  from: v.optional(v.object({ window: IndexSchema, tab: IndexSchema })),
  visits: v.array(VisitSchema),
});

const VisitedSchema = v.object({
  generation: IndexSchema,
  visits: v.array(VisitSchema),
  // Optional, so a list stored before tabs were tracked still reads.
  tabs: v.optional(v.array(TabVisitsSchema), []),
  focused: v.optional(v.pipe(v.number(), v.integer())),
});

type Visited = v.InferOutput<typeof VisitedSchema>;
type StoredVisit = v.InferOutput<typeof VisitSchema>;

async function read(): Promise<Visited | null> {
  const stored = await visitedItem.getValue();
  if (stored === null) return null;
  const parsed = v.safeParse(VisitedSchema, stored);
  if (!parsed.success) {
    throw new Error("The stored visited origins do not match the current schema.");
  }
  return parsed.output;
}

/** The kept visit updated by a newer one: its page when it names one, its carry flag as given. */
function merged(kept: Visit | undefined, visit: Visit): StoredVisit {
  const url = visit.url ?? kept?.url;
  return {
    origin: visit.origin,
    ...(url !== undefined && { url }),
    ...(visit.carry === true && { carry: true as const }),
  };
}

/** `list` with `visits` added in the order first seen and the kept ones updated. */
function mergedInto(list: readonly StoredVisit[], visits: readonly Visit[]): StoredVisit[] {
  const merging = [...list];
  for (const visit of visits) {
    const index = merging.findIndex(({ origin }) => origin === visit.origin);
    if (index === -1) merging.push(merged(undefined, visit));
    else merging[index] = merged(merging[index], visit);
  }
  return merging;
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs one change at a time, so two commits never drop each other's origin. */
function change(generation: number, update: (current: Visited) => Visited): Promise<void> {
  const next = queue.then(async () => {
    const current = await read();
    const kept =
      current?.generation === generation ? current : { generation, visits: [], tabs: [] };
    const updated = update(kept);
    if (JSON.stringify(updated) !== JSON.stringify(current)) await visitedItem.setValue(updated);
  });
  queue = next.catch(() => undefined);
  return next;
}

const note: VisitedOrigins["note"] = (generation, visits) =>
  change(generation, (current) => ({ ...current, visits: mergedInto(current.visits, visits) }));

const noteTab: VisitedOrigins["noteTab"] = (generation, tabId, visits, from) =>
  change(generation, (current) => {
    const kept = current.tabs.find((each) => each.tabId === tabId);
    const others = current.tabs.filter((each) => each.tabId !== tabId);
    const place = from ?? kept?.from;
    const tab = {
      tabId,
      ...(place && { from: place }),
      visits: mergedInto(kept?.visits ?? [], visits),
    };
    return { ...current, tabs: [...others, tab] };
  });

const replaceTab: VisitedOrigins["replaceTab"] = (generation, removed, added) =>
  change(generation, (current) => ({
    ...current,
    tabs: current.tabs.map((tab) => (tab.tabId === removed ? { ...tab, tabId: added } : tab)),
  }));

async function visited(generation: number): Promise<Visit[]> {
  const current = await read();
  return current?.generation === generation ? current.visits : [];
}

async function tabVisits(generation: number): Promise<TabVisits[]> {
  const current = await read();
  return current?.generation === generation ? current.tabs : [];
}

const noteFocus: VisitedOrigins["noteFocus"] = (generation, windowId) =>
  change(generation, (current) => ({ ...current, focused: windowId }));

async function focusedWindow(generation: number): Promise<number | undefined> {
  const current = await read();
  return current?.generation === generation ? current.focused : undefined;
}

/** The origins each managed window visited, validated like every stored value. */
export const visitedOrigins: VisitedOrigins = {
  note,
  visited,
  noteTab,
  replaceTab,
  tabVisits,
  noteFocus,
  focusedWindow,
};
