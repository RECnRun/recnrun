import * as v from "valibot";
import { browser } from "wxt/browser";
import {
  FileReadRequestSchema,
  POC_READ_FILE,
  readFailure,
  readFileUrl,
  toReadResult,
} from "@/p2p/file-url-read";
import type { FileReadResult, WebApis } from "@/p2p/file-url-read";

const OptionsSchema = v.strictObject({
  via: v.picklist(["page", "offscreen"]),
  cache: v.optional(v.string()),
  api: v.optional(v.string()),
});

type Send = (message: unknown) => Promise<unknown>;
type Holder = { __poc?: Record<string, unknown> };

/** Reads `url` in this page, or asks the offscreen document through the background; one shape. */
function createReadFile(send: Send, apis: WebApis) {
  return async (url: unknown, options: unknown): Promise<FileReadResult> => {
    const parsedOptions = v.safeParse(OptionsSchema, options);
    if (!parsedOptions.success) return readFailure(new Error("via must be page or offscreen."));
    const { via, ...rest } = parsedOptions.output;
    const parsed = v.safeParse(FileReadRequestSchema, { type: POC_READ_FILE, url, ...rest });
    if (!parsed.success) return readFailure(new Error(parsed.issues[0].message));
    if (via === "page") return readFileUrl(parsed.output, apis);
    return send(parsed.output).then(
      (answer) => toReadResult(answer, "The background"),
      readFailure,
    );
  };
}

/**
 * E3 (POC PLAN.md P1.4): `window.__poc.readFile(url, { via, cache?, api? })`, which the harness
 * evaluates; merged into `window.__poc`, so other diagnostics keep their own functions there.
 */
export function installReadFile(
  target: object,
  send: Send = (message) => browser.runtime.sendMessage(message),
  apis: WebApis = globalThis,
): void {
  const holder = target as Holder;
  holder.__poc = { ...holder.__poc, readFile: createReadFile(send, apis) };
}
