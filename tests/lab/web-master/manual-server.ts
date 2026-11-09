import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { SITE } from "./stand-in.ts";

/*
 * LAB-ONLY manual mode of M-TW.16 (w-manual.spec.ts): the stand-in site plus `manual.js`, served
 * on plain http://127.0.0.1 so the owner can open it in any Chrome, the personal Default included,
 * with no CDP. The page reaches the spec through `/manual/*` on its own origin.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
};
const TAG = '<script type="module" src="/manual.js"></script>';

export interface ManualRoutes {
  /** The page's paired public key; answers what the page needs once the worker is up. */
  key(jwk: JsonWebKey): Promise<unknown>;
  /** The page's offer; answers the worker's answer and identity. */
  link(sdp: string): Promise<unknown>;
  log(text: string): void;
  finish(): void;
  closing(): void;
}

export interface ManualServer {
  origin: string;
  close(): Promise<void>;
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

async function file(name: string): Promise<Buffer | string> {
  const body = await readFile(join(SITE, name));
  if (name !== "index.html") return body;
  return String(body).replace("</head>", `  ${TAG}\n  </head>`);
}

function serveFile(url: string, response: ServerResponse): void {
  const name = url === "/" ? "index.html" : url.slice(1);
  const type = TYPES[extname(name)];
  if (!type || name.includes("/")) {
    response.writeHead(404).end();
    return;
  }
  void file(name).then(
    (body) => response.writeHead(200, { "content-type": type }).end(body),
    () => response.writeHead(404).end(),
  );
}

async function route(routes: ManualRoutes, path: string, text: string): Promise<unknown> {
  if (path === "/manual/key") return routes.key(JSON.parse(text) as JsonWebKey);
  if (path === "/manual/link") return routes.link((JSON.parse(text) as { sdp: string }).sdp);
  if (path === "/manual/log") routes.log((JSON.parse(text) as { text: string }).text);
  else if (path === "/manual/finish") routes.finish();
  else if (path === "/manual/closing") routes.closing();
  else throw new Error(`unknown route ${path}`);
  return { ok: true };
}

function handler(routes: ManualRoutes) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? "/";
    if (request.method !== "POST" || !url.startsWith("/manual/")) {
      serveFile(url, response);
      return;
    }
    void bodyOf(request)
      .then((text) => route(routes, url, text))
      .then(
        (reply) =>
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(reply)),
        (error: Error) => response.writeHead(500).end(error.message),
      );
  };
}

export async function startManualServer(routes: ManualRoutes): Promise<ManualServer> {
  const server = createServer(handler(routes));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
