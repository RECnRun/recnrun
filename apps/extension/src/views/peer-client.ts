import * as v from "valibot";
import { browser } from "wxt/browser";
import { BackgroundReplySchema } from "@/messaging/background-reply";
import { PeerNoticeSchema, peerRequestMessage } from "@/messaging/peer-messages";
import type { PeerRequest } from "@/messaging/peer-messages";

/** How a page asks the background about the other profile, and hears that something changed. */
export interface PeerClient {
  ask: <T>(request: PeerRequest, result: v.GenericSchema<unknown, T>) => Promise<T>;
  watch: (onChange: () => void) => () => void;
}

type Runtime = Pick<typeof browser.runtime, "sendMessage" | "onMessage">;

export function createPeerClient(runtime: Runtime = browser.runtime): PeerClient {
  return {
    ask: async (request, result) => {
      const reply = v.parse(
        BackgroundReplySchema,
        await runtime.sendMessage(peerRequestMessage(request)),
      );
      if (!reply.ok) throw new Error(reply.error);
      return v.parse(result, reply.result);
    },
    watch: (onChange) => {
      const listener = (message: unknown) => {
        if (v.is(PeerNoticeSchema, message)) onChange();
      };
      runtime.onMessage.addListener(listener);
      return () => runtime.onMessage.removeListener(listener);
    },
  };
}
