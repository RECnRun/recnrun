import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { SITE } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";

/*
 * LAB-ONLY owner page: the stand-in site plus `owner.js` on http://127.0.0.1:47811/, and the
 * lab target fixture on :47812. The page talks to the launcher only through the folder the owner
 * chose, so this server answers GET requests alone and never opens a browser.
 */

export const OWNER_PORT = 47811;
export const TARGET_PORT = 47812;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
};
const TAG = '<script type="module" src="/owner.js"></script>';

async function file(name: string): Promise<Buffer | string> {
  const body = await readFile(join(SITE, name));
  if (name !== "index.html") return body;
  return String(body).replace("</head>", `  ${TAG}\n  </head>`);
}

function handler(request: IncomingMessage, response: ServerResponse): void {
  const url = request.url ?? "/";
  const name = url === "/" ? "index.html" : url.slice(1);
  const type = TYPES[extname(name)];
  if (request.method !== "GET" || !type || name.includes("/")) {
    response.writeHead(404).end();
    return;
  }
  void file(name).then(
    (body) => response.writeHead(200, { "content-type": type }).end(body),
    () => response.writeHead(404).end(),
  );
}

export async function startOwnerServer(port = OWNER_PORT): Promise<{ close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = await startTarget(TARGET_PORT);
  await startOwnerServer();
  console.log(`owner page: http://127.0.0.1:${OWNER_PORT}/  target: ${target.origin}/interact`);
}
