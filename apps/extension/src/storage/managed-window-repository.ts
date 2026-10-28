import { ManagedWindowStateSchema } from "@recnrun/domain";
import type { ManagedWindowState } from "@recnrun/domain";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";

// Local storage: the generation must keep counting across browser restarts.
const managedWindowItem = storage.defineItem<unknown>("local:managed-window");

/** Reads the managed Incognito window, validating it like every stored value. */
async function read(): Promise<ManagedWindowState | null> {
  const stored = await managedWindowItem.getValue();
  if (stored === null) return null;
  const parsed = v.safeParse(ManagedWindowStateSchema, stored);
  if (!parsed.success) {
    throw new Error("The stored Incognito window does not match the current schema.");
  }
  return parsed.output;
}

type Change<T> = (current: ManagedWindowState | null) => T | Promise<T>;

let queue: Promise<unknown> = Promise.resolve();

/** Runs changes one at a time, so a late removal never overwrites a window opened after it. */
function update<T extends ManagedWindowState | null>(change: Change<T>): Promise<T> {
  const next = queue.then(async () => {
    const current = await read();
    const changed = await change(current);
    if (changed !== current) await managedWindowItem.setValue(changed);
    return changed;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** The one Incognito window RECnRun opened, and the generation count, for the background. */
export const managedWindowRepository = { read, update };
