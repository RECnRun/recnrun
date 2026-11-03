import { type Call, createCall } from "@/api/http";
import { type OnOpen, type Subscribe, createEventBus } from "@/api/events";

/** What screens use: commands to the service and the messages it pushes. Tests pass a fake. */
export type Api = { call: Call; on: Subscribe; onOpen: OnOpen };

/** The token the service injects into the page it serves; never stored or logged. */
export function readToken(doc: Document): string | undefined {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="recnrun-token"]');
  return meta?.content || undefined;
}

/** The API of the service that served this page, over HTTP and its WebSocket. */
export function createServiceApi(token: string, location: Location): Api {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const bus = createEventBus({
    url: `${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`,
  });
  return { call: createCall({ token }), on: bus.on, onOpen: bus.onOpen };
}
