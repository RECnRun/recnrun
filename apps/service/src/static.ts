import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join } from "node:path";

/** The UI may load its own files and talk to this service over HTTP and the loopback WebSocket. */
export const UI_CSP = [
  "default-src 'self'",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

const TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

// Vite writes hashed files flat under assets/; anything else, `..` included, is not served.
const ASSET = /^\/assets\/[\w-][\w.-]*$/;

/** The paths the UI is served on; they need `Host` and `Origin`, never the token. */
export function isUiPath(path: string): boolean {
  return path === "/" || path === "/index.html" || ASSET.test(path);
}

const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EISDIR");

// index.html carries the token of this run of the service, so no cache ever keeps it.
function send(response: ServerResponse, status: number, type: string, body: string | Buffer) {
  response.writeHead(status, {
    "content-type": type,
    "content-security-policy": UI_CSP,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
  response.end(body);
}

/** index.html carries the token in `<meta name="recnrun-token">`; only a same-origin page can read it. */
function withToken(html: string, token: string): string {
  const meta = `<meta name="recnrun-token" content="${token}">`;
  return html.includes("</head>") ? html.replace("</head>", `${meta}</head>`) : meta + html;
}

/** Serves `GET /` (index.html, never cached) and `GET /assets/<file>` from the built UI in `root`. */
export async function serveUi(
  root: string,
  path: string,
  token: string,
  response: ServerResponse,
): Promise<void> {
  const index = path === "/" || path === "/index.html";
  const file = index ? join(root, "index.html") : join(root, "assets", path.slice(8));
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const text = index ? "The UI is not built; run `vp run -r build`." : "Not found.";
    return send(response, index ? 503 : 404, "text/plain; charset=utf-8", text);
  }
  if (index) return send(response, 200, "text/html; charset=utf-8", withToken(String(body), token));
  send(response, 200, TYPES[extname(file)] ?? "application/octet-stream", body);
}
