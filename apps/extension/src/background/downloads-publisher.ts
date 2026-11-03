import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { NamespaceSchema, probePath } from "@/p2p/downloads-rendezvous";
import { MAX_CODE_LENGTH } from "@/p2p/protocol";

/*
 * The one place that calls chrome.downloads (POC PLAN.md §5). Only the POC builds register it;
 * the diagnostics page, and later the offscreen document, reach it by message.
 */

/** What chrome.downloads reports of an item, as the probe answers it. */
export interface DownloadItem {
  id: number;
  filename: string;
  state: string;
  error?: string;
  exists?: boolean;
  bytesReceived?: number;
}

type Delta = { id: number; state?: { current?: string } };
type ConflictAction = "uniquify" | "overwrite" | "prompt";

/** The part of chrome.downloads the publisher uses. */
export interface DownloadsPort {
  download(options: {
    url: string;
    filename: string;
    saveAs: boolean;
    conflictAction: ConflictAction;
  }): Promise<number>;
  search(query: { id?: number }): Promise<DownloadItem[]>;
  cancel(id: number): Promise<void>;
  onChanged: {
    addListener(listener: (delta: Delta) => void): void;
    removeListener(listener: (delta: Delta) => void): void;
  };
}

interface Identity {
  extensionId: string;
  /** The extension origin with a trailing slash, which only its own pages' URLs start with. */
  extensionUrl: string;
}

// A slow source for the interrupted-download cell must stay on the loopback (no egress).
const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[\w./-]*$/;
const SETTLE_MS = 30_000;

const PocDownloadMessageSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("POC_DOWNLOAD_PROBE"),
    namespace: NamespaceSchema,
    content: v.pipe(v.string(), v.maxLength(MAX_CODE_LENGTH)),
    conflictAction: v.optional(v.picklist(["uniquify", "overwrite", "prompt"])),
    /** A raw destination instead of the namespace's probe path, so experiments see Chrome refuse or rename it. */
    filename: v.optional(v.pipe(v.string(), v.maxLength(1024))),
    url: v.optional(v.pipe(v.string(), v.regex(LOOPBACK_URL))),
    /** `false` answers as soon as Chrome assigned an id; otherwise once the item completes or stops. */
    settle: v.optional(v.boolean()),
  }),
  v.strictObject({ type: v.literal("POC_DOWNLOAD_CANCEL"), id: v.number() }),
  v.strictObject({ type: v.literal("POC_DOWNLOAD_SEARCH"), id: v.optional(v.number()) }),
]);

type PocDownloadMessage = v.InferOutput<typeof PocDownloadMessageSchema>;
type ProbeMessage = Extract<PocDownloadMessage, { type: "POC_DOWNLOAD_PROBE" }>;

const dataUrl = (content: string) =>
  `data:application/json;charset=utf-8,${encodeURIComponent(content)}`;

/** Resolves once the item leaves `in_progress`, or after `ms`, whichever comes first. */
function settled(downloads: DownloadsPort, id: number, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      downloads.onChanged.removeListener(listener);
      resolve();
    };
    const listener = (delta: Delta) => {
      if (delta.id === id && delta.state?.current && delta.state.current !== "in_progress") done();
    };
    const timer = setTimeout(done, ms);
    downloads.onChanged.addListener(listener);
    // The item may have settled before the listener was added.
    void downloads.search({ id }).then(([item]) => item && item.state !== "in_progress" && done());
  });
}

async function itemOf(downloads: DownloadsPort, id: number): Promise<DownloadItem> {
  const [item] = await downloads.search({ id });
  if (!item) throw new Error(`No download ${id} in Chrome's history.`);
  const { filename, state, error, exists, bytesReceived } = item;
  return { id, filename, state, ...(error ? { error } : {}), exists, bytesReceived };
}

async function probe(downloads: DownloadsPort, message: ProbeMessage, settleMs: number) {
  const id = await downloads.download({
    url: message.url ?? dataUrl(message.content),
    filename: message.filename ?? probePath(message.namespace),
    saveAs: false,
    conflictAction: message.conflictAction ?? "overwrite",
  });
  if (message.settle !== false) await settled(downloads, id, settleMs);
  return itemOf(downloads, id);
}

function run(downloads: DownloadsPort, message: PocDownloadMessage, settleMs: number) {
  switch (message.type) {
    case "POC_DOWNLOAD_PROBE":
      return probe(downloads, message, settleMs);
    case "POC_DOWNLOAD_CANCEL":
      return downloads.cancel(message.id).then(() => itemOf(downloads, message.id));
    case "POC_DOWNLOAD_SEARCH":
      return downloads
        .search(message.id === undefined ? {} : { id: message.id })
        .then((items) => ({ count: items.length, items }));
  }
}

/** A runtime.onMessage listener for the POC Downloads messages of the extension's own pages. */
export function createDownloadsListener(
  downloads: DownloadsPort,
  identity: Identity,
  settleMs = SETTLE_MS,
) {
  return (
    message: unknown,
    sender: Browser.runtime.MessageSender,
    sendResponse: (reply: unknown) => void,
  ) => {
    const parsed = v.safeParse(PocDownloadMessageSchema, message);
    const ownPage =
      sender.id === identity.extensionId && sender.url?.startsWith(identity.extensionUrl);
    if (!parsed.success || !ownPage) return false;
    run(downloads, parsed.output, settleMs).then(
      (result) => sendResponse({ ok: true, result }),
      (error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }),
    );
    return true;
  };
}

/** Registers the publisher next to the background's own listener; POC builds only. */
export function startDownloadsPublisher(): void {
  const identity = { extensionId: browser.runtime.id, extensionUrl: browser.runtime.getURL("/") };
  browser.runtime.onMessage.addListener(createDownloadsListener(browser.downloads, identity));
}
