import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { methodNotAllowed, send, sendText } from "./http.ts";
import { renderIndex } from "./routes.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const HTML = "text/html; charset=utf-8";
const TYPES: Readonly<Record<string, string>> = {
  ".html": HTML,
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** Decodes a request path, or returns undefined when it is malformed or could leave `public/`. */
function decodePath(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const unsafe = /[\0\\]/.test(decoded) || decoded.split("/").includes("..");
  return unsafe ? undefined : decoded;
}

/** Maps `/routes/<name>` to its page and anything else to the file of the same path. */
function publicFile(path: string): string | undefined {
  const target = path.startsWith("/routes/") && extname(path) === "" ? `${path}.html` : path;
  const file = resolve(PUBLIC_DIR, `.${target}`);
  return file.startsWith(PUBLIC_DIR) ? file : undefined;
}

export async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    methodNotAllowed(response, "GET, HEAD");
    return;
  }
  const path = decodePath(pathname);
  if (path === undefined) {
    sendText(response, 400, "Bad request path\n");
    return;
  }
  if (path === "/") {
    send(response, 200, renderIndex(), { "Content-Type": HTML });
    return;
  }
  const file = publicFile(path);
  // A directory or a missing file both fail to read and answer 404.
  const body = file ? await readFile(file).catch(() => undefined) : undefined;
  if (!file || !body) {
    sendText(response, 404, "Not found\n");
    return;
  }
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  send(response, 200, request.method === "HEAD" ? "" : body, { "Content-Type": type });
}
