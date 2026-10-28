import * as v from "valibot";
import { browser } from "wxt/browser";
import {
  ORIGIN_AGENT_PORT,
  OriginCommandSchema,
  OriginProbeSchema,
} from "@/messaging/origin-protocol";
import type { OriginCommand, OriginPort } from "@/messaging/origin-protocol";
import { captureOrigin } from "@/origin/capture";
import { OriginFailure } from "@/origin/failure";
import { restoreOrigin } from "@/origin/restore";
import type { OriginStores } from "@/origin/restore";

type Operation = Pick<OriginCommand, "operationId" | "generation">;

/** Runs the command's work and posts its last reply, or `failed` with a step and error name. */
async function replyAfter(
  port: OriginPort,
  operation: Operation,
  work: () => Promise<object>,
): Promise<void> {
  const { operationId, generation } = operation;
  let reply: object;
  try {
    reply = { ...(await work()), operationId, generation };
  } catch (error) {
    const reason = error instanceof OriginFailure ? error.message : "unexpected";
    reply = { type: "failed", operationId, generation, error: reason };
  }
  port.postMessage(reply);
}

/** The cookie names in a `document.cookie` line; Chrome writes a nameless cookie as its value alone. */
function cookieNames(line: string): string[] {
  return line
    .split("; ")
    .filter(Boolean)
    .map((pair) => (pair.includes("=") ? pair.slice(0, pair.indexOf("=")) : ""));
}

function run(
  port: OriginPort,
  stores: OriginStores,
  command: OriginCommand,
  documentCookie: () => string,
): Promise<void> {
  const { operationId, generation } = command;
  if (command.type === "restore") {
    return replyAfter(port, command, async () => ({
      type: "restored",
      counts: await restoreOrigin(stores, command.payload),
    }));
  }
  // Each message goes out while the read transaction is live; the port keeps their order.
  const sink = {
    storage: (entries: object) =>
      port.postMessage({ type: "capture-storage", operationId, generation, ...entries }),
    database: (database: unknown) =>
      port.postMessage({ type: "capture-database", operationId, generation, database }),
    records: (database: string, store: string, records: unknown[]) =>
      port.postMessage({
        type: "capture-records",
        operationId,
        generation,
        database,
        store,
        records,
      }),
    cache: (cache: unknown, unsupported: unknown[]) =>
      port.postMessage({ type: "capture-cache", operationId, generation, cache, unsupported }),
  };
  return replyAfter(port, command, async () => ({
    type: "captured",
    counts: await captureOrigin(stores, sink, command.chunk),
    cookieNames: cookieNames(documentCookie()),
  }));
}

/** Calls `next` with the one message that follows, removing itself first. */
function once(port: OriginPort, next: (message: unknown) => void): void {
  const listener = (message: unknown) => {
    port.onMessage.removeListener(listener);
    next(message);
  };
  port.onMessage.addListener(listener);
}

/**
 * Echoes the background's probe as it arrived, then acts on the next message only: a valid restore
 * or capture of the probe's operation runs once, anything else ends the link. Until then the agent
 * touches nothing, which matters since it may run in any page of the origin.
 */
export function runOriginAgent(
  port: OriginPort,
  stores: OriginStores,
  documentCookie: () => string = () => document.cookie,
): void {
  once(port, (message) => {
    const probe = v.safeParse(OriginProbeSchema, message);
    if (!probe.success) return port.disconnect();
    const { operationId, generation } = probe.output;
    port.postMessage({ ...probe.output, type: "probe-echo" });
    once(port, (next) => {
      const command = v.safeParse(OriginCommandSchema, next);
      const ours =
        command.success &&
        command.output.operationId === operationId &&
        command.output.generation === generation;
      if (ours) void run(port, stores, command.output, documentCookie);
      else port.disconnect();
    });
  });
}

/** The origin agent's content script: registered behind the barrier, or injected for a capture. */
export function startOriginAgent(): void {
  const port = browser.runtime.connect({ name: ORIGIN_AGENT_PORT });
  // `caches` exists only in a secure context; elsewhere naming it throws.
  const cacheStorage = isSecureContext ? caches : undefined;
  runOriginAgent(port, { localStorage, sessionStorage, indexedDB, caches: cacheStorage });
}
