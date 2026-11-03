import { readFile } from "node:fs/promises";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
const MAX_BODY = 64 * 1024;

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, {
    "Content-Type": CONTENT_TYPES[".json"],
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export function redirect(res: ServerResponse, location: string, headers: OutgoingHttpHeaders = {}) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store", ...headers });
  res.end();
}

export function noContent(res: ServerResponse, headers: OutgoingHttpHeaders = {}): void {
  res.writeHead(204, { "Cache-Control": "no-store", ...headers });
  res.end();
}

export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key = "", ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/** A host-only session cookie; an empty value with maxAge 0 deletes it. */
export function sessionCookie(name: string, value: string, maxAge?: number): string {
  // App and API hosts are cross-site, so the cookie must be SameSite=None, which requires Secure;
  // Chrome treats http://*.localhost as potentially trustworthy and accepts it.
  const expiry = maxAge === undefined ? "" : `; Max-Age=${maxAge}`;
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=None${expiry}`;
}

function resolvePublic(root: string, pathname: string): string | null {
  try {
    const file = join(root, normalize(decodeURIComponent(pathname)));
    return file.startsWith(root + sep) ? file : null;
  } catch {
    return null;
  }
}

export async function serveStatic(res: ServerResponse, root: string, pathname: string) {
  const file = resolvePublic(root, pathname === "/" ? "/index.html" : pathname);
  const body = file === null ? null : await readFile(file).catch(() => null);
  if (file === null || body === null) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  res.end(body);
}
