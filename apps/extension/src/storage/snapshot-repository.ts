import { emptySnapshot, SnapshotSchema } from "@recnrun/domain";
import type { Snapshot } from "@recnrun/domain";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";

const snapshotItem = storage.defineItem<unknown>("local:snapshot");

/** Reads the stored snapshot, validating it because storage outlives schema changes. */
export async function readSnapshot(): Promise<Snapshot> {
  const stored = await snapshotItem.getValue();
  if (stored === null) return emptySnapshot();
  const parsed = v.safeParse(SnapshotSchema, stored);
  if (!parsed.success) throw new Error("The stored data does not match the current schema.");
  return parsed.output;
}
