import { OriginSchema } from "@recnrun/domain";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";
import type { VisitedOrigins } from "@/ports/visited-origins";

// Session storage: it outlives a stopped service worker and ends with the browser, as Incognito does.
const visitedItem = storage.defineItem<unknown>("session:visited-origins");

const VisitedSchema = v.object({
  generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
  origins: v.array(OriginSchema),
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

let queue: Promise<unknown> = Promise.resolve();

/** Runs one change at a time, so two commits never drop each other's origin. */
function note(generation: number, origins: readonly string[]): Promise<void> {
  const next = queue.then(async () => {
    const current = await read();
    const kept = current?.generation === generation ? current.origins : [];
    const fresh = origins.filter(
      (each, index) => !kept.includes(each) && origins.indexOf(each) === index,
    );
    if (fresh.length > 0 || current?.generation !== generation) {
      await visitedItem.setValue({ generation, origins: [...kept, ...fresh] });
    }
  });
  queue = next.catch(() => undefined);
  return next;
}

async function visited(generation: number): Promise<string[]> {
  const current = await read();
  return current?.generation === generation ? current.origins : [];
}

/** The origins each managed window visited, validated like every stored value. */
export const visitedOrigins: VisitedOrigins = { note, visited };
