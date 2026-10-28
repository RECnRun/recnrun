import type { OriginData } from "@recnrun/domain";
import * as v from "valibot";
import type { BarrierOperation } from "@/background/workspace/barrier";
import { WorkspaceError } from "@/background/workspace/errors";
import { ORIGIN_AGENT_PORT, OriginReplySchema } from "@/messaging/origin-protocol";
import type { OriginPort, OriginReply, RestoredCounts } from "@/messaging/origin-protocol";

/** The one document an operation restores into: the barrier's tab, as Chrome committed it. */
export interface AgentExpectation {
  tabId: number;
  documentId: string;
  origin: string;
}

/**
 * The agent is registered for the whole origin, so it also connects from other tabs and frames;
 * only the top frame of the committed document in the managed tab gets the payload.
 */
export function isExpectedAgent(port: OriginPort, expected: AgentExpectation): boolean {
  const sender = port.sender;
  return (
    port.name === ORIGIN_AGENT_PORT &&
    sender?.tab?.id === expected.tabId &&
    sender.frameId === 0 &&
    sender.documentId === expected.documentId &&
    sender.origin === expected.origin
  );
}

function replyTo(message: unknown, operation: BarrierOperation): OriginReply | undefined {
  const reply = v.safeParse(OriginReplySchema, message);
  if (!reply.success) return undefined;
  const { operationId, generation } = reply.output;
  return operationId === operation.id && generation === operation.generation
    ? reply.output
    : undefined;
}

/** Sends the payload to a validated agent and waits, at most `boundMs`, for its own answer. */
export function restoreThroughAgent(
  port: OriginPort,
  operation: BarrierOperation,
  payload: OriginData,
  boundMs: number,
): Promise<RestoredCounts> {
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      try {
        port.onMessage.removeListener(onReply);
        port.onDisconnect.removeListener(onGone);
      } catch {
        // A port whose page is gone has no listener left to remove.
      }
      finish();
    };
    const onReply = (message: unknown) => {
      const reply = replyTo(message, operation);
      if (reply?.type === "restored") settle(() => resolve(reply.counts));
      if (reply?.type === "failed") {
        const error = `The page could not restore its data (${reply.error}).`;
        settle(() => reject(new WorkspaceError("RestoreFailed", error)));
      }
    };
    const onGone = () => {
      const error = "The page closed before its data was restored.";
      settle(() => reject(new WorkspaceError("AgentDisconnected", error)));
    };
    const timer = setTimeout(() => {
      port.disconnect();
      const error = "The page did not restore its data in time.";
      settle(() => reject(new WorkspaceError("RestoreTimedOut", error)));
    }, boundMs);
    const { id: operationId, generation } = operation;
    // Chrome throws, rather than fires onDisconnect, when the page went before this port was used.
    try {
      port.onMessage.addListener(onReply);
      port.onDisconnect.addListener(onGone);
      port.postMessage({ type: "restore", operationId, generation, payload });
    } catch {
      onGone();
    }
  });
}
