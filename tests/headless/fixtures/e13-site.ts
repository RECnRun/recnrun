import { createServer } from "node:http";
import type { Server } from "node:http";

/*
 * The static test page of E13 (POC source §9): served on the loopback inside the container, it
 * carries one worker's exclusive marker in its title, sets a persistent cookie, and the start page
 * navigates itself to it. The server records every request so the harness reads what a worker's
 * Chrome did without a CDP client on it.
 */

/** One request the page server saw. */
interface Seen {
  path: string;
  cookie: string;
  at: number;
}

export interface Site {
  origin: string;
  seen: Seen[];
  /** The address a worker opens first, then leaves for the marker page. */
  startUrl(id: string): string;
  markerUrl(id: string): string;
  /** `marker:<id>`, the title of the marker page. */
  titleOf(id: string): string;
  close(): Promise<void>;
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>${body}`;

/** The static pages are served from memory; the marker id is a path segment of letters and digits. */
export async function startSite(): Promise<Site> {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    seen.push({ path, cookie: request.headers.cookie ?? "", at: Date.now() });
    const [, kind = "", id = ""] = /^\/(\w+)\/([A-Za-z0-9]+)/.exec(path) ?? [];
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    if (kind === "marker") {
      // A persistent cookie: Chrome flushes it to disk within about 30 s (CHROMIUM.md group 17).
      headers["set-cookie"] = `e13=${id}; Max-Age=3600; Path=/`;
      response.writeHead(200, headers).end(page(`marker:${id}`, `<h1>marker:${id}</h1>`));
    } else if (kind === "start") {
      const next = JSON.stringify(`/marker/${id}`);
      const script = `<script>setTimeout(() => location.replace(${next}), 2000)</script>`;
      response.writeHead(200, headers).end(page(`start:${id}`, script));
    } else {
      response.writeHead(200, headers).end(page("static", "<h1>static</h1>"));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    seen,
    startUrl: (id) => `${origin}/start/${id}`,
    markerUrl: (id) => `${origin}/marker/${id}`,
    titleOf: (id) => `marker:${id}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
