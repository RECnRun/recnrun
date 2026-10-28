import type { IdentityCapture } from "@recnrun/domain";
import type { CaptureReceiver } from "@/background/workspace/agent-link";
import { WorkspaceError } from "@/background/workspace/errors";
import { ownBlobs } from "@/background/workspace/own-blobs";
import { collectValueTypes } from "@/background/workspace/value-types";
import type { CapturedCounts } from "@/messaging/origin-protocol";
import type { CapturePart, IdentityCaptures } from "@/storage/identity-captures";

type ValueType = IdentityCapture["valueTypes"][number];
type OriginCapture = IdentityCapture["origins"][number];
type Database = OriginCapture["indexedDB"][number];
type Unsupported = IdentityCapture["unsupported"][number];
export type WebStorage = Pick<OriginCapture, "localStorage" | "sessionStorage">;

/** What the collector received, checked against the agent's counts before anything is published. */
export interface Collected {
  storage?: WebStorage;
  databases: Database[];
  valueTypes: ValueType[];
  records: number;
  caches: number;
  cacheEntries: number;
  unsupported: Unsupported[];
}

/** Appends parts one after another; after one write fails, it writes no later part. */
function orderedWriter(captureId: string, captures: Pick<IdentityCaptures, "append">) {
  let writing = Promise.resolve();
  let failure: { error: unknown } | undefined;
  const write = (part: CapturePart, owned: object[] = []) => {
    writing = writing.then(async () => {
      if (failure) return;
      try {
        await ownBlobs(owned);
        await captures.append(captureId, part);
      } catch (error) {
        failure = { error };
      }
    });
  };
  const settled = async () => {
    await writing;
    if (failure) throw failure.error;
  };
  return { write, settled };
}

/** Writes each received part in order and keeps what the counts are checked against. */
export function collector(
  captureId: string,
  origin: string,
  captures: Pick<IdentityCaptures, "append">,
) {
  const collected: Collected = {
    databases: [],
    valueTypes: [],
    records: 0,
    caches: 0,
    cacheEntries: 0,
    unsupported: [],
  };
  const valueTypes = new Set<ValueType>();
  const { write, settled } = orderedWriter(captureId, captures);
  const receiver: CaptureReceiver = {
    storage: ({ localStorage, sessionStorage }) => {
      collected.storage = { localStorage, sessionStorage };
    },
    database: (database) => collected.databases.push(database),
    records: ({ database, store, records }) => {
      collected.records += records.length;
      collectValueTypes(
        records.flatMap(({ key, value }) => (key === undefined ? [value] : [key, value])),
        valueTypes,
      );
      write({ origin, database, store, records }, records);
    },
    cache: ({ cache, unsupported }) => {
      collected.caches += 1;
      collected.cacheEntries += cache.entries.length;
      for (const item of unsupported)
        collected.unsupported.push({ adapter: "cacheStorage", ...item });
      write({ origin, cache });
    },
  };
  const written = async (): Promise<Collected> => {
    await settled();
    return { ...collected, valueTypes: [...valueTypes] };
  };
  return { receiver, written };
}

/** Every count the agent sent must match what arrived, or the capture is not whole. */
export function checkWhole(collected: Collected, counts: CapturedCounts): WebStorage {
  const { storage, databases, records, caches, cacheEntries } = collected;
  const whole =
    storage !== undefined &&
    Object.keys(storage.localStorage).length === counts.localStorage &&
    Object.keys(storage.sessionStorage).length === counts.sessionStorage &&
    databases.length === counts.databases &&
    records === counts.records &&
    caches === counts.caches &&
    cacheEntries === counts.cacheEntries;
  if (!whole) throw new WorkspaceError("CaptureIncomplete", "The page's data did not all arrive.");
  return storage;
}
