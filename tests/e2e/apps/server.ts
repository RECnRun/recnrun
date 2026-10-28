// Fixture origins for the POC specs: app.localhost:5192 and other.localhost:5192 share these routes.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { appFrame, appModule, appPage, appPixel, appWorker, siteCsp } from "./app-pages.ts";
import { frameCookies, framePage, jarCookies, jarPage } from "./cookie-pages.ts";
import { blankPage, inspectPage, sentinelPage, serviceWorker } from "./pages.ts";

const PORT = 5192;

type LogEntry =
  | {
      kind: "request";
      method: string;
      path: string;
      host: string;
      dest: string;
      cookies: string[];
      time: number;
    }
  | { kind: "report"; host: string; body: unknown; time: number };

const logs = new Map<string, LogEntry[]>();

function cookiesOf(request: IncomingMessage): Record<string, string> {
  const pairs = (request.headers.cookie ?? "").split(/;\s*/).filter(Boolean);
  return Object.fromEntries(
    pairs.map((pair) => {
      const [name = "", ...value] = pair.split("=");
      return [name, value.join("=")];
    }),
  );
}

function record(run: string | undefined, entry: LogEntry): void {
  if (run === undefined) return;
  const entries = logs.get(run) ?? [];
  entries.push(entry);
  logs.set(run, entries);
}

function send(response: ServerResponse, type: string, body: string, headers = {}): void {
  response.writeHead(200, { "content-type": type, "cache-control": "no-store", ...headers });
  response.end(body);
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const HTML = "text/html; charset=utf-8";

interface Exchange {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  host: string;
  run: string | undefined;
}

function sentinel({ response, url }: Exchange): void {
  const tag = url.searchParams.get("tag") ?? "untagged";
  const cookie = `sentinel_http=${encodeURIComponent(tag)}; Path=/; HttpOnly; SameSite=Lax`;
  send(response, HTML, sentinelPage(tag), { "set-cookie": cookie });
}

async function report({ request, response, host, run }: Exchange): Promise<void> {
  record(run, { kind: "report", host, body: await bodyOf(request), time: Date.now() });
  send(response, "application/json", "{}");
}

/** `/app/`; `?csp=1` puts the site's own strict policy on the final document response. */
function app({ response, url, run }: Exchange): void {
  const nonce = randomBytes(16).toString("base64");
  const csp =
    url.searchParams.get("csp") === "1" ? { "content-security-policy": siteCsp(nonce) } : {};
  send(response, HTML, appPage(run ?? "", nonce), csp);
}

/** One hop before the app, as sign-in and locale redirects do; `?to=other` leaves the origin. */
function redirect({ response, url }: Exchange): void {
  const away = url.searchParams.get("to") === "other" ? "http://other.localhost:5192" : "";
  response.writeHead(302, { location: `${away}/app/${url.search}`, "cache-control": "no-store" });
  response.end();
}

const JS = "text/javascript";

const routes: Record<string, (exchange: Exchange) => void | Promise<void>> = {
  "GET /health": ({ response }) => send(response, "text/plain", "ok"),
  "GET /sentinel": sentinel,
  "GET /blank": ({ response }) => send(response, HTML, blankPage),
  "GET /jar": ({ response, run }) =>
    send(response, HTML, jarPage, { "set-cookie": jarCookies(run ?? "") }),
  "GET /jar-frame": ({ response }) =>
    send(response, HTML, framePage, { "set-cookie": frameCookies }),
  "GET /inspect": ({ request, response, run }) =>
    send(response, HTML, inspectPage(cookiesOf(request), run ?? "")),
  "GET /sw.js": ({ response }) => send(response, JS, serviceWorker),
  "GET /app/": app,
  "GET /app/redirect": redirect,
  "GET /app/module.js": ({ response }) => send(response, JS, appModule),
  "GET /app/worker.js": ({ response }) => send(response, JS, appWorker),
  "GET /app/frame": ({ response }) => send(response, HTML, appFrame),
  "GET /app/pixel.svg": ({ response }) => send(response, "image/svg+xml", appPixel),
  "GET /app/data.json": ({ response }) => send(response, "application/json", '{"status":"ok"}'),
  "POST /__log": report,
  "GET /__log": ({ response, run }) =>
    send(response, "application/json", JSON.stringify({ entries: logs.get(run ?? "") ?? [] })),
};

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const host = request.headers.host ?? "";
  const url = new URL(request.url ?? "/", "http://localhost");
  const run = url.searchParams.get("run") ?? cookiesOf(request).run;
  const method = request.method ?? "GET";
  const key = `${method} ${url.pathname}`;
  // Reading the log is not part of what a spec observes.
  if (key !== "GET /__log") {
    const dest = String(request.headers["sec-fetch-dest"] ?? "");
    const cookies = Object.keys(cookiesOf(request)).sort();
    const path = url.pathname;
    record(run, { kind: "request", method, path, host, dest, cookies, time: Date.now() });
  }
  const handler = routes[key];
  if (handler) return handler({ request, response, url, host, run });
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
}

createServer((request, response) => {
  route(request, response).catch((error: unknown) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(String(error));
  });
}).listen(PORT, () => console.log(`Fixture server on http://localhost:${PORT}`));
