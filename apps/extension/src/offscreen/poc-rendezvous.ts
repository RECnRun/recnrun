import * as v from "valibot";
import { browser } from "wxt/browser";
import { BackgroundReplySchema } from "@/messaging/background-reply";
import { PocRendezvousResults, pocRendezvousRequest } from "@/messaging/poc-rendezvous";
import { downloadsTransport } from "@/p2p/downloads-transport";
import type { DownloadsContext, DownloadsWriter } from "@/p2p/downloads-transport";
import { readFileUrl } from "@/p2p/file-url-read";
import type { WebApis } from "@/p2p/file-url-read";
import type { RendezvousTransport } from "@/p2p/rendezvous-transport";

type Send = (message: unknown) => Promise<unknown>;

interface PocRendezvousOptions {
  send?: Send;
  apis?: WebApis;
}

/**
 * P3.1 (POC PLAN.md): the Downloads transport as the offscreen document runs it. It reads the
 * others' files itself, through file://, and writes and erases through the background.
 */
export function pocDownloadsRendezvous({
  send = (message) => browser.runtime.sendMessage(message),
  apis = globalThis as WebApis,
}: PocRendezvousOptions = {}): (me: string) => RendezvousTransport {
  const ask = async <T>(schema: v.GenericSchema<unknown, T>, request: unknown): Promise<T> => {
    const reply = v.safeParse(BackgroundReplySchema, await send(request));
    if (!reply.success) throw new Error("The background did not answer.");
    if (!reply.output.ok) throw new Error(reply.output.error);
    return v.parse(schema, reply.output.result);
  };
  let located: DownloadsContext | undefined;
  // The namespace and the root hold for the session once Chrome reported the root, so a poll wakes no worker.
  const context = async () => {
    if (located?.root) return located;
    located = await ask(PocRendezvousResults.context, pocRendezvousRequest("context", {}));
    return located;
  };
  const boot = () => ask(PocRendezvousResults.boot, pocRendezvousRequest("boot", {}));
  const writer: DownloadsWriter = {
    write: (path, text) =>
      ask(PocRendezvousResults.write, pocRendezvousRequest("write", { path, text })),
    erase: (id) => ask(PocRendezvousResults.erase, pocRendezvousRequest("erase", { id })),
  };
  // no-store, so a poll never answers with the bytes an earlier one read (E3).
  const read = async (url: string) => {
    const result = await readFileUrl({ url, cache: "no-store" }, apis);
    return result.ok ? result.text : undefined;
  };
  return (me) => downloadsTransport({ me, context, boot, writer, read });
}
