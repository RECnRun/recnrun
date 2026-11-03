import * as v from "valibot";

/** The message a POC page sends to read a file:// URL through the offscreen document (E3). */
export const POC_READ_FILE = "POC_READ_FILE";

// `only-if-cached` needs a same-origin request, which a file:// read never is.
const CACHE_MODES = ["default", "no-store", "reload", "no-cache", "force-cache"] as const;

export const FileReadRequestSchema = v.strictObject({
  type: v.literal(POC_READ_FILE),
  url: v.pipe(v.string(), v.startsWith("file:///")),
  cache: v.optional(v.picklist(CACHE_MODES)),
  /** The web API that reads it; `xhr` is the alternative when `fetch` fails in a context. */
  api: v.optional(v.picklist(["fetch", "xhr"])),
});

export type FileReadRequest = v.InferOutput<typeof FileReadRequestSchema>;

const FileReadResultSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(true), status: v.number(), text: v.string() }),
  v.strictObject({
    ok: v.literal(false),
    error: v.strictObject({ name: v.string(), message: v.string() }),
  }),
]);

export type FileReadResult = v.InferOutput<typeof FileReadResultSchema>;

/** The web APIs of the context that reads, injected so Node tests can stand in for them. */
export interface WebApis {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  XMLHttpRequest?: typeof XMLHttpRequest;
}

export function readFailure(error: unknown): FileReadResult {
  if (error instanceof Error)
    return { ok: false, error: { name: error.name, message: error.message } };
  return { ok: false, error: { name: "Error", message: String(error) } };
}

/** An answer from another context, or a failure naming who did not answer. */
export function toReadResult(answer: unknown, from: string): FileReadResult {
  const parsed = v.safeParse(FileReadResultSchema, answer);
  return parsed.success ? parsed.output : readFailure(new Error(`${from} did not answer.`));
}

async function fetchText(apis: WebApis, url: string, cache?: RequestCache) {
  const response = await apis.fetch(url, cache === undefined ? {} : { cache });
  return { ok: true as const, status: response.status, text: await response.text() };
}

function xhrText(Xhr: typeof XMLHttpRequest | undefined, url: string): Promise<FileReadResult> {
  if (!Xhr) return Promise.resolve(readFailure(new Error("XMLHttpRequest is not available.")));
  return new Promise((resolve) => {
    const request = new Xhr();
    request.open("GET", url);
    // file:// answers with status 0, so the text is the result, not the status.
    request.onload = () =>
      resolve({ ok: true, status: request.status, text: request.responseText });
    request.onerror = () =>
      resolve({ ok: false, error: { name: "NetworkError", message: "XMLHttpRequest failed" } });
    request.send();
  });
}

/** Reads `url` with the context's own web API; never throws, so every answer has one shape. */
export async function readFileUrl(
  { url, cache, api }: Omit<FileReadRequest, "type">,
  apis: WebApis = globalThis,
): Promise<FileReadResult> {
  try {
    return api === "xhr"
      ? await xhrText(apis.XMLHttpRequest, url)
      : await fetchText(apis, url, cache);
  } catch (error) {
    return readFailure(error);
  }
}
