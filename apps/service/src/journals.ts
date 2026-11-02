import { openJournal, type JournalWriter } from "@recnrun/persistence";

/** Every journal the service has open, so stopping closes each one after its pending lines. */
export interface JournalRegistry {
  /** Opens a journal through persistence and tracks it until it is closed. */
  open(path: string): Promise<JournalWriter>;
  /** Refuses new journals, then closes every open one; resolves with the errors of those that failed. */
  drain(): Promise<string[]>;
  readonly openCount: number;
}

export class ServiceStoppingError extends Error {
  constructor() {
    super("The service is stopping; no journal can be opened.");
    this.name = "ServiceStoppingError";
  }
}

export function createJournalRegistry(
  open: (path: string) => Promise<JournalWriter> = openJournal,
): JournalRegistry {
  const writers = new Set<JournalWriter>();
  let draining = false;
  return {
    async open(path) {
      if (draining) throw new ServiceStoppingError();
      const writer = await open(path);
      const tracked: JournalWriter = {
        path: writer.path,
        append: (event) => writer.append(event),
        close: async () => {
          writers.delete(tracked);
          await writer.close();
        },
      };
      writers.add(tracked);
      // A drain that began while this one opened would otherwise leave it open.
      if (draining) {
        await tracked.close();
        throw new ServiceStoppingError();
      }
      return tracked;
    },
    async drain() {
      draining = true;
      const results = await Promise.allSettled([...writers].map((writer) => writer.close()));
      return results.flatMap((result) =>
        result.status === "rejected" ? [String(result.reason)] : [],
      );
    },
    get openCount() {
      return writers.size;
    },
  };
}
