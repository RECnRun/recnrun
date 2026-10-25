import * as v from "valibot";
import {
  ClosePanelMessageSchema,
  LocationMessageSchema,
  NavigateMessageSchema,
  OpenPanelMessageSchema,
  PanelClosedMessageSchema,
  RouteMessageSchema,
} from "@/messaging/frame-protocol";

/** Every message on the `recnrun-frame` channel, told apart by `type`. */
const FrameMessageSchema = v.variant("type", [
  RouteMessageSchema,
  NavigateMessageSchema,
  LocationMessageSchema,
  OpenPanelMessageSchema,
  PanelClosedMessageSchema,
  ClosePanelMessageSchema,
]);

type FrameMessage = v.InferOutput<typeof FrameMessageSchema>;

type Messages = { [T in FrameMessage["type"]]: Extract<FrameMessage, { type: T }> };

/** One handler per message type a subscriber cares about; the other types are ignored. */
export type FrameHandlers = { [T in keyof Messages]?: (message: Messages[T]) => void };

interface Subscriber {
  from: Window;
  origin: string;
  handlers: FrameHandlers;
}

interface Channel {
  subscribers: Set<Subscriber>;
  close(): void;
}

const channels = new WeakMap<Window, Channel>();

function deliver<T extends keyof Messages>(
  handlers: FrameHandlers,
  type: T,
  message: Messages[T],
): void {
  handlers[type]?.(message);
}

/** The page's one `message` listener: it validates once and hands the message to each subscriber. */
function openChannel(page: Window): Channel {
  const subscribers = new Set<Subscriber>();
  const onMessage = (event: MessageEvent) => {
    const parsed = v.safeParse(FrameMessageSchema, event.data);
    if (!parsed.success) return;
    for (const { from, origin, handlers } of subscribers) {
      if (event.source !== from || event.origin !== origin) continue;
      deliver(handlers, parsed.output.type, parsed.output);
    }
  };
  page.addEventListener("message", onMessage);
  const channel = { subscribers, close: () => page.removeEventListener("message", onMessage) };
  channels.set(page, channel);
  return channel;
}

/**
 * Handles the frame messages that `from` posts to `page` from `origin`. Subscribers of one page
 * share one listener, so no message is parsed twice; the returned function unsubscribes.
 */
export function subscribeFrame(
  page: Window,
  from: Window | null,
  origin: string,
  handlers: FrameHandlers,
): () => void {
  // A frame without a window posts nothing, and no subscriber may match messages without a source.
  if (from === null) return () => {};
  const channel = channels.get(page) ?? openChannel(page);
  const subscriber: Subscriber = { from, origin, handlers };
  channel.subscribers.add(subscriber);
  return () => {
    channel.subscribers.delete(subscriber);
    if (channel.subscribers.size > 0) return;
    channel.close();
    channels.delete(page);
  };
}
