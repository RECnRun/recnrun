import * as v from "valibot";
import { storage } from "wxt/utils/storage";
import type { IncognitoStoreMemory } from "@/ports/incognito-stores";

// Local storage: an Incognito profile may outlive a stopped service worker.
const storesItem = storage.defineItem<unknown>("local:incognito-store-ids");

const StoreIdsSchema = v.array(v.pipe(v.string(), v.minLength(1)));

async function read(): Promise<string[]> {
  const stored = await storesItem.getValue();
  if (stored === null) return [];
  const parsed = v.safeParse(StoreIdsSchema, stored);
  if (!parsed.success) {
    throw new Error("The stored Incognito cookie store ids do not match the current schema.");
  }
  return parsed.output;
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs one change at a time, so two listings never drop each other's ids. */
function remember(ids: readonly string[]): Promise<void> {
  const next = queue.then(async () => {
    const kept = await read();
    const fresh = ids.filter((id, index) => !kept.includes(id) && ids.indexOf(id) === index);
    if (fresh.length > 0) await storesItem.setValue([...kept, ...fresh]);
  });
  queue = next.catch(() => undefined);
  return next;
}

/** Every Incognito cookie store id Chrome listed, validated like every stored value. */
export const incognitoStoreMemory: IncognitoStoreMemory = { read, remember };
