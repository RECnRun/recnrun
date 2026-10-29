import type { IdentityCapture, OriginCapture, SkippedOrigin } from "@recnrun/domain";
import { captureThroughAgent } from "@/background/workspace/agent-link";
import type { CaptureReceiver } from "@/background/workspace/agent-link";
import type { BarrierOperation } from "@/background/workspace/barrier";
import { checkWhole, collector } from "@/background/workspace/capture-collector";
import type { Collected } from "@/background/workspace/capture-collector";
import { visitOrigins } from "@/background/workspace/helper-tab";
import type { HelperDeps } from "@/background/workspace/helper-tab";
import type { CapturedCounts, CapturedPage, OriginPort } from "@/messaging/origin-protocol";
import type { Visit } from "@/ports/visited-origins";
import type { IdentityCaptures } from "@/storage/identity-captures";

type Unsupported = IdentityCapture["unsupported"][number];

/** How long the agent may take to connect, and to send its next message. */
export const CAPTURE_BOUND_MS = 15_000;

/** One origin's data as its agent sent it, written as parts under the capture's id. */
export interface OriginRead {
  origin: OriginCapture;
  collected: Collected;
  page: CapturedPage;
}

export interface Reading {
  operation: BarrierOperation;
  captureId: string;
}

export interface ReadDeps {
  captures: Pick<IdentityCaptures, "append" | "dropParts" | "read">;
  boundMs?: number;
}

/** Reads one origin's page through its agent; every part is written before the counts are checked. */
export async function readOrigin(
  port: OriginPort,
  { operation, captureId }: Reading,
  origin: string,
  deps: Pick<ReadDeps, "captures" | "boundMs">,
): Promise<OriginRead> {
  const { receiver, written } = collector(captureId, origin, deps.captures);
  const boundMs = deps.boundMs ?? CAPTURE_BOUND_MS;
  const page = await captureThroughAgent(port, operation, receiver, { idleMs: boundMs }).catch(
    async (error: unknown) => {
      // Parts already on their way land first, so a caller that drops them drops them all.
      await written().catch(() => undefined);
      throw error;
    },
  );
  const collected = await written();
  const storage = checkWhole(collected, page.counts);
  const read = { origin, ...storage, indexedDB: collected.databases, caches: [] };
  return { origin: read, collected, page };
}

/** The counts a page would have sent for what was carried, so the totals include it. */
function countsOf(previous: OriginCapture, collected: Collected): CapturedCounts {
  return {
    localStorage: Object.keys(previous.localStorage).length,
    sessionStorage: Object.keys(previous.sessionStorage).length,
    databases: collected.databases.length,
    records: collected.records,
    caches: collected.caches,
    cacheEntries: collected.cacheEntries,
  };
}

/** Hands a saved origin's data to a collector in the order and shape its agent sends it. */
function replay(previous: OriginCapture, receiver: CaptureReceiver, reading: Reading): void {
  const tag = { operationId: reading.operation.id, generation: reading.operation.generation };
  const { localStorage, sessionStorage } = previous;
  receiver.storage({ localStorage, sessionStorage });
  for (const database of previous.indexedDB) {
    const stores = database.stores.map((store) => ({ ...store, records: [] }));
    receiver.database({ ...database, stores });
    for (const { name: store, records } of database.stores) {
      const part = { type: "capture-records" as const, ...tag, database: database.name, store };
      if (records.length > 0) receiver.records({ ...part, records });
    }
  }
  for (const cache of previous.caches) {
    receiver.cache({ type: "capture-cache", ...tag, cache, unsupported: [] });
  }
}

/** Writes the identity's last saved storage of an origin into the new capture, as its agent would. */
async function carried(previous: OriginCapture, reading: Reading, deps: ReadDeps) {
  const { receiver, written } = collector(reading.captureId, previous.origin, deps.captures);
  replay(previous, receiver, reading);
  const collected = await written();
  const counts = countsOf(previous, collected);
  const origin = { ...previous, indexedDB: collected.databases, caches: [] };
  return { origin, collected, page: { counts, cookieNames: [] } } satisfies OriginRead;
}

interface Fallen {
  origin: string;
  step: SkippedOrigin["step"];
  reason: string;
}

/** What the other origins came to: their reads, and the ones left out, each by origin and step. */
export interface OthersRead {
  reads: OriginRead[];
  skipped: SkippedOrigin[];
  unsupported: Unsupported[];
}

const NOT_RESTORED = "The last start could not restore it, so the window never held it.";

/**
 * Reads each other visited origin in the helper tab. One that does not answer, whose page fails,
 * or that the last start could not restore keeps the identity's last saved storage of it, or is
 * named as unsupported when there is none; the capture goes on either way.
 */
export async function readOthers(
  visits: readonly Visit[],
  reading: Reading & { windowId: number; identityId: string },
  deps: ReadDeps & { helper: HelperDeps },
): Promise<OthersRead> {
  const tried = visits.filter(({ carry }) => carry !== true);
  const visiting = {
    windowId: reading.windowId,
    operation: reading.operation,
    work: "save" as const,
  };
  const outcomes = await visitOrigins(tried, visiting, deps.helper, async (agent, { origin }) => {
    try {
      return await readOrigin(agent, reading, origin, deps);
    } catch (error) {
      await deps.captures.dropParts(reading.captureId, origin);
      throw error;
    }
  });
  const fallen: Fallen[] = visits
    .filter(({ carry }) => carry === true)
    .map(({ origin }) => ({ origin, step: "not-restored", reason: NOT_RESTORED }));
  const result: OthersRead = { reads: [], skipped: [], unsupported: [] };
  for (const outcome of outcomes) {
    if (outcome.ok) result.reads.push(outcome.value);
    else fallen.push(outcome);
  }
  if (fallen.length > 0) await keepOrName(fallen, result, reading, deps);
  return result;
}

/** Carries each left-out origin's last saved storage into the capture, or names it unsupported. */
async function keepOrName(
  fallen: readonly Fallen[],
  result: OthersRead,
  reading: Reading & { identityId: string },
  deps: ReadDeps,
): Promise<void> {
  const previous = await deps.captures.read(reading.identityId);
  for (const { origin, step, reason } of fallen) {
    const saved = previous?.origins.find((each) => each.origin === origin);
    if (saved) result.reads.push(await carried(saved, reading, deps));
    else result.unsupported.push({ adapter: "origins", item: origin, reason });
    result.skipped.push({ origin, work: "save", step, reason, kept: saved !== undefined });
  }
}
