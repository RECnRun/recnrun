// Fixture origins for the POC specs: app.localhost, other.localhost, and sso.localhost (port 5192)
// share these routes.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { appFrame, appModule, appPage, appPixel, appWorker, siteCsp } from "./app-pages.ts";
import { bodyOf, cookiesOf, HTML, JS, redirectTo, send } from "./http.ts";
import type { Exchange } from "./http.ts";
import { domainJarCookies, frameCookies, framePage, jarCookies, jarPage } from "./cookie-pages.ts";
import { pwaRoutes } from "./pwa-routes.ts";
import { spaPage, spaRoutes } from "./spa-routes.ts";
import { ssoRoutes } from "./sso-routes.ts";
import { blankPage, inspectPage, sentinelPage, serviceWorker, signInPage } from "./pages.ts";
import { writersHtml, writersServiceWorker, writersWorker } from "./writer-pages.ts";

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

function record(run: string | undefined, entry: LogEntry): void {
  if (run === undefined) return;
  const entries = logs.get(run) ?? [];
  entries.push(entry);
  logs.set(run, entries);
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

/**
 * One hop before the app, as sign-in and locale redirects do; `?to=other` leaves the origin, and
 * `?type=binary` and `?attachment=1` give it a body Chrome would download, as Gmail's does.
 */
function redirect({ response, url }: Exchange): void {
  const away = url.searchParams.get("to") === "other" ? "http://other.localhost:5192" : "";
  const binary = url.searchParams.get("type") === "binary";
  const attachment = url.searchParams.get("attachment") === "1";
  response.writeHead(302, {
    location: `${away}/app/${url.search}`,
    "cache-control": "no-store",
    ...(binary ? { "content-type": "application/binary" } : {}),
    ...(attachment ? { "content-disposition": "attachment" } : {}),
  });
  response.end();
}

const APP_ORIGIN = "http://app.localhost:5192";

/** A redirect to the cached page, as a sign-in or a moved resource answers. */
function cacheRedirect({ response }: Exchange): void {
  redirectTo(response, "/cache/basic?via=redirect");
}

/** A cross-site API the app may read: one exposed header, one the page never sees. */
function cacheCors({ response }: Exchange): void {
  send(response, "application/json", '{"api":true}', {
    "access-control-allow-origin": APP_ORIGIN,
    "access-control-expose-headers": "x-shown",
    "x-shown": "1",
    "x-hidden": "1",
  });
}

/** A response that depends on a request header, and says so with Vary. */
function cacheVary({ request, response }: Exchange): void {
  const variant = String(request.headers["x-variant"] ?? "");
  send(response, "text/plain", `variant ${variant}`, { vary: "x-variant", "x-kind": "vary" });
}

let changes = 0;

/** A page that is never the same twice, as one that changed since the capture. */
function cacheChanging({ response }: Exchange): void {
  changes += 1;
  send(response, "text/plain", `change ${changes}`);
}

/** Hosts a spec took down: a request to one drops its connection, as an unreachable server. */
const downHosts = new Set<string>();

/** The spec's switch: `{ host, down }`. */
async function setDown({ request, response }: Exchange): Promise<void> {
  const { host, down } = (await bodyOf(request)) as { host: string; down: boolean };
  if (down) downHosts.add(host);
  else downHosts.delete(host);
  send(response, "application/json", JSON.stringify({ down: [...downHosts] }));
}

/** The root of signin.localhost is a sign-in page, and the SPA's is its app; other hosts have none. */
function root(exchange: Exchange): void {
  const { response, host } = exchange;
  if (host.startsWith("signin.")) return send(response, HTML, signInPage);
  if (host.startsWith("spa-")) return spaPage(exchange);
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
}

const routes: Record<string, (exchange: Exchange) => void | Promise<void>> = {
  "GET /": root,
  "GET /health": ({ response }) => send(response, "text/plain", "ok"),
  "GET /sentinel": sentinel,
  "GET /blank": ({ response }) => send(response, HTML, blankPage),
  "GET /jar": ({ response, run }) =>
    send(response, HTML, jarPage, { "set-cookie": jarCookies(run ?? "") }),
  "GET /domain-jar": ({ response, host }) =>
    send(response, HTML, blankPage, { "set-cookie": domainJarCookies(host) }),
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
  "GET /writers/": ({ response, run }) => send(response, HTML, writersHtml(run ?? "")),
  "GET /writers/worker.js": ({ response }) => send(response, JS, writersWorker),
  "GET /writers/sw.js": ({ response }) => send(response, JS, writersServiceWorker),
  "GET /cache/basic": ({ response }) =>
    send(response, "application/json", '{"basic":true}', { "x-kind": "basic" }),
  "GET /cache/redirect": cacheRedirect,
  "GET /cache/cors": cacheCors,
  "GET /cache/vary": cacheVary,
  "GET /cache/changing": cacheChanging,
  "GET /cache/none": ({ response }) => {
    response.writeHead(204, { "x-kind": "none" });
    response.end();
  },
  ...pwaRoutes,
  ...ssoRoutes,
  ...spaRoutes,
  "POST /__log": report,
  "POST /__down": setDown,
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
  if (downHosts.has(host)) return void request.socket.destroy();
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
