import type { BridgeHost } from "@recnrun/bridge";
import * as v from "valibot";
import { TimelineMessageSchema } from "@/messaging/background-protocol";
import type { TimelineMessage } from "@/messaging/background-protocol";

/** The part of `runtime.Port` the relay uses. */
export interface RelayPort {
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

function deliver(emit: BridgeHost["emit"], message: TimelineMessage): void {
  switch (message.name) {
    case "stepRecorded":
      emit("stepRecorded", message.data);
      break;
    case "recordingChanged":
      emit("recordingChanged", message.data);
      break;
  }
}

/**
 * Turns timeline port messages into bridge events for the page. The service worker drops ports
 * when it idles, so the relay reconnects; it returns a function that stops it.
 */
export function createTimelineRelay(
  connect: () => RelayPort,
  emit: BridgeHost["emit"],
  retryMs: number,
): () => void {
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const open = (): void => {
    const port = connect();
    port.onMessage.addListener((message) => {
      const parsed = v.safeParse(TimelineMessageSchema, message);
      if (parsed.success) deliver(emit, parsed.output);
    });
    port.onDisconnect.addListener(() => {
      if (!stopped) retry = setTimeout(open, retryMs);
    });
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(retry);
  };
}
