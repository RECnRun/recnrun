import * as v from "valibot";
import { BackgroundReplySchema } from "@/messaging/background-reply";
import type { BackgroundReply } from "@/messaging/background-reply";

export interface ProbeOptions {
  conflictAction?: "uniquify" | "overwrite" | "prompt";
  filename?: string;
  url?: string;
  settle?: boolean;
}

type Send = (message: unknown) => Promise<unknown>;

/** A reply of the background, or an error naming the message it did not answer properly. */
export async function ask(
  send: Send,
  message: { type: string; [key: string]: unknown },
): Promise<BackgroundReply> {
  const parsed = v.safeParse(BackgroundReplySchema, await send(message));
  if (!parsed.success) {
    throw new Error(`The background sent a malformed reply to ${message.type}.`);
  }
  return parsed.output;
}

/** Experiments drive the real extension path through these, never chrome.downloads directly. */
export function downloadMessages(send: Send) {
  return {
    probe: (namespace: string, content: string, options: ProbeOptions = {}) =>
      ask(send, { type: "POC_DOWNLOAD_PROBE", namespace, content, ...options }),
    cancel: (id: number) => ask(send, { type: "POC_DOWNLOAD_CANCEL", id }),
    search: (id?: number) =>
      ask(send, { type: "POC_DOWNLOAD_SEARCH", ...(id === undefined ? {} : { id }) }),
  };
}
