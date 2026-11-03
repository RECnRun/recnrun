import type { CaptureSurface, ObserverMessage } from "@recnrun/protocol";
import type { Draft } from "./capture-envelope.ts";
import { hookProducer } from "./observer-delivery.ts";

const KIND_SURFACES: Record<string, CaptureSurface> = {
  dom: "dom-events",
  storage: "web-storage",
  lifecycle: "navigation",
};

/** A collector gap whose event type is its reason. */
export const gapDraft = (payload: Record<string, unknown>): Draft => ({
  category: "gap",
  type: String(payload["reason"]),
  component: "collector",
  payload,
});

/** The journal draft of an accepted hook message. */
export function observedDraft(message: ObserverMessage): Draft {
  if (message.kind === "gap") {
    const { kinds, ...range } = message.payload;
    const surface = kinds.length === 1 ? KIND_SURFACES[kinds[0] as string] : undefined;
    const producer = hookProducer(message.documentId);
    return gapDraft({
      reason: "buffer-exhausted",
      producer,
      ...range,
      ...(surface && { surface }),
    });
  }
  if (message.kind === "dom")
    return {
      category: "dom",
      type: message.type,
      component: "application",
      payload: message.payload,
    };
  if (message.kind === "storage") {
    const payload = { observation: "observed-operation", ...message.payload };
    return { category: "storage", type: "operation", component: "application", payload };
  }
  return {
    category: "target",
    type: "hook-installed",
    component: "collector",
    payload: message.payload,
  };
}
