import * as v from "valibot";
import { browser } from "wxt/browser";
import { ORIGIN_AGENT_PORT, OriginCommandSchema } from "@/messaging/origin-protocol";
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

function run(port: OriginPort, stores: OriginStores, command: OriginCommand): Promise<void> {
  const { operationId, generation } = command;
  if (command.type === "restore") {
    return replyAfter(port, command, async () => ({
      type: "restored",
      counts: await restoreOrigin(stores, command.payload),
    }));
  }
  // Each message goes out while the read transaction is live; the port keeps their order.
  const sink = {
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
  };
  // The background checks that this Date arrives as one before it trusts any value.
  port.postMessage({ type: "capture-started", operationId, generation, probe: new Date(0) });
  return replyAfter(port, command, async () => ({
    type: "captured",
    counts: await captureOrigin(stores.indexedDB, sink, command.chunk),
  }));
}

/**
 * Acts on the first message only: a valid restore or capture runs once, anything else ends the
 * link. Until then the agent touches nothing, which matters since it may run in any page of the
 * origin.
 */
export function runOriginAgent(port: OriginPort, stores: OriginStores): void {
  const onCommand = (message: unknown) => {
    port.onMessage.removeListener(onCommand);
    const command = v.safeParse(OriginCommandSchema, message);
    if (command.success) void run(port, stores, command.output);
    else port.disconnect();
  };
  port.onMessage.addListener(onCommand);
}

/** The origin agent's content script: registered behind the barrier, or injected for a capture. */
export function startOriginAgent(): void {
  const port = browser.runtime.connect({ name: ORIGIN_AGENT_PORT });
  runOriginAgent(port, { localStorage, sessionStorage, indexedDB });
}
