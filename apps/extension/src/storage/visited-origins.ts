import { OriginSchema } from "@recnrun/domain";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";
import type { Visit, VisitedOrigins } from "@/ports/visited-origins";

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

const VisitedSchema = v.object({
  generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
  visits: v.array(VisitSchema),
});

type Visited = v.InferOutput<typeof VisitedSchema>;

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
function merged(kept: Visit | undefined, visit: Visit): Visit {
  const url = visit.url ?? kept?.url;
  return {
    origin: visit.origin,
    ...(url !== undefined && { url }),
    ...(visit.carry === true && { carry: true }),
  };
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs one change at a time, so two commits never drop each other's origin. */
function note(generation: number, visits: readonly Visit[]): Promise<void> {
  const next = queue.then(async () => {
    const current = await read();
    const list: Visit[] = current?.generation === generation ? [...current.visits] : [];
    for (const visit of visits) {
      const index = list.findIndex(({ origin }) => origin === visit.origin);
      if (index === -1) list.push(merged(undefined, visit));
      else list[index] = merged(list[index], visit);
    }
    const updated = { generation, visits: list };
    if (JSON.stringify(updated) !== JSON.stringify(current)) await visitedItem.setValue(updated);
  });
  queue = next.catch(() => undefined);
  return next;
}

async function visited(generation: number): Promise<Visit[]> {
  const current = await read();
  return current?.generation === generation ? current.visits : [];
}

/** The origins each managed window visited, validated like every stored value. */
export const visitedOrigins: VisitedOrigins = { note, visited };
