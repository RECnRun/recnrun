import * as v from "valibot";
import { browser } from "wxt/browser";
import { ORIGIN_AGENT_PORT, OriginRestoreCommandSchema } from "@/messaging/origin-protocol";
import type { OriginPort } from "@/messaging/origin-protocol";
import { RestoreFailure, restoreOrigin } from "@/origin/restore";
import type { OriginStores } from "@/origin/restore";

type RestoreCommand = v.InferOutput<typeof OriginRestoreCommandSchema>;

async function restoreAndReply(
  port: OriginPort,
  stores: OriginStores,
  command: RestoreCommand,
): Promise<void> {
  const { operationId, generation } = command;
  let reply: object;
  try {
    const counts = await restoreOrigin(stores, command.payload);
    reply = { type: "restored", operationId, generation, counts };
  } catch (error) {
    const reason = error instanceof RestoreFailure ? error.message : "unexpected";
    reply = { type: "failed", operationId, generation, error: reason };
  }
  port.postMessage(reply);
}

/**
 * Acts on the first message only: a valid restore runs once, anything else ends the link. Until
 * then the agent touches nothing, which matters since it runs in every page of the origin.
 */
export function runOriginAgent(port: OriginPort, stores: OriginStores): void {
  const onCommand = (message: unknown) => {
    port.onMessage.removeListener(onCommand);
    const command = v.safeParse(OriginRestoreCommandSchema, message);
    if (command.success) void restoreAndReply(port, stores, command.output);
    else port.disconnect();
  };
  port.onMessage.addListener(onCommand);
}

/** The origin agent's content script, registered only while an operation restores an origin. */
export function startOriginAgent(): void {
  const port = browser.runtime.connect({ name: ORIGIN_AGENT_PORT });
  runOriginAgent(port, { localStorage, sessionStorage, indexedDB });
}
