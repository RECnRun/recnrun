// Starts the service, queues `count` journal lines through it, and stops on SIGTERM.
import { startService, stopOnSignals } from "../../../apps/service/src/index.ts";

const [home, path, count] = process.argv.slice(2);
if (home === undefined || path === undefined || count === undefined) {
  throw new Error("Usage: journal-writer <home> <path> <count>");
}
const started = await startService({ home });
if (started.reused) throw new Error("A service already runs for this home.");
const journal = await started.service.journals.open(path);
stopOnSignals(started.service);

const event = (seq: number) => ({
  schemaVersion: 1 as const,
  id: `cdp:S1#${seq}`,
  runId: "run-1",
  seq,
  source: "S1",
  producer: "cdp:S1",
  timestamp: new Date().toISOString(),
  targetId: "T1",
  frameId: "T1",
  documentId: null,
  category: "console" as const,
  type: "api",
  payload: { level: "log", args: [`message ${seq} ${"x".repeat(200)}`] },
});

// Lines are queued faster than the disk takes them, so SIGTERM lands while most are still pending.
const queued = Array.from({ length: Number(count) }, (_unused, index) =>
  journal.append(event(index + 1)),
);
console.log("queued");
await Promise.allSettled(queued);
