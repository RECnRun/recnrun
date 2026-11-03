import type { IncomingMessage, ServerResponse } from "node:http";
import {
  methodNotAllowed,
  readBody,
  redirect,
  send,
  sendJson,
  sendText,
  startStream,
} from "./http.ts";
import { handleOrders, type OrderCounts } from "./orders.ts";

export interface ApiContext {
  readonly urls: { readonly first: string; readonly second: string };
  nextSerial(): number;
  readonly orders: OrderCounts;
}

type Handler = (response: ServerResponse, url: URL, context: ApiContext) => void;

// A 1x1 PNG, so the binary case has a real image body.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const MAX_FORM_BYTES = 64 * 1024;
const MAX_REDIRECT_HOPS = 10;
const STREAM_CHUNKS = 10;
const STREAM_INTERVAL_MS = 300;
const SLOW_STREAM_INTERVAL_MS = 1_500;
const MAX_LARGE_BYTES = 4 * 1024 * 1024;
const LARGE_PATTERN = "0123456789abcdef";
const LONG_EVENT_LENGTH = 5_000;

const failCase = (url: URL) => url.searchParams.get("fail") ?? "";

function stream(response: ServerResponse, url: URL): void {
  const interval = failCase(url) === "slow" ? SLOW_STREAM_INTERVAL_MS : STREAM_INTERVAL_MS;
  startStream(response, "text/plain; charset=utf-8");
  let sent = 0;
  const timer = setInterval(() => {
    sent += 1;
    response.write(`chunk ${sent}\n`);
    if (sent < STREAM_CHUNKS) return;
    clearInterval(timer);
    response.end();
  }, interval);
  response.once("close", () => clearInterval(timer));
}

// A deterministic body of `?bytes=N` bytes, so a test can predict what a size cap keeps.
function large(response: ServerResponse, url: URL): void {
  const bytes = Math.min(Math.max(Number(url.searchParams.get("bytes")) || 0, 0), MAX_LARGE_BYTES);
  const body = LARGE_PATTERN.repeat(Math.ceil(bytes / LARGE_PATTERN.length)).slice(0, bytes);
  send(response, 200, body, { "Content-Type": "text/plain; charset=utf-8" });
}

// A long `retry` keeps EventSource from reconnecting at once after the stream ends.
function events(response: ServerResponse): void {
  startStream(response, "text/event-stream");
  const long = "y".repeat(LONG_EVENT_LENGTH);
  response.end(
    `retry: 60000\n\ndata: hello fixture\n\nevent: tick\nid: 7\ndata: tock\n\ndata: ${long}\n\n`,
  );
}

// Sensitive values in both directions; the body only says whether credentials arrived.
function secret(response: ServerResponse): void {
  const authorized = typeof response.req.headers.authorization === "string";
  send(response, 200, JSON.stringify({ ok: true, authorized }), {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": "fixture-session=s3cr3t-cookie; Path=/; HttpOnly; SameSite=Strict",
    "X-Fixture-Token": "s3cr3t-reply",
  });
}

// A cookie the page cannot read, which storage capture reports without its value.
function cookies(response: ServerResponse, url: URL): void {
  const clear = url.searchParams.has("clear");
  send(response, 200, JSON.stringify({ httpOnly: clear ? "cleared" : "set" }), {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": clear
      ? "fixture-httponly=; Path=/; HttpOnly; Max-Age=0"
      : "fixture-httponly=s3cr3t-httponly; Path=/; HttpOnly; SameSite=Lax",
  });
}

const GET_HANDLERS: Readonly<Record<string, Handler>> = {
  "/api/config": (response, _url, { urls }) =>
    sendJson(response, 200, { origin: urls.first, secondOrigin: urls.second }),
  "/api/json": (response, url) =>
    failCase(url) === "api-500"
      ? sendJson(response, 500, { ok: false, error: "Injected failure (fail=api-500)" })
      : sendJson(response, 200, { ok: true, items: ["alpha", "beta", "gamma"] }),
  "/api/binary": (response) => send(response, 200, PNG, { "Content-Type": "image/png" }),
  "/api/error": (response) =>
    sendJson(response, 500, { ok: false, error: "Server error on purpose" }),
  "/api/cacheable": (response, _url, context) =>
    sendJson(response, 200, { serial: context.nextSerial() }),
  "/api/stream": stream,
  "/api/events": events,
  "/api/large": large,
  "/api/secret": secret,
  "/api/cookies": cookies,
  "/api/cached": (response) =>
    send(response, 200, JSON.stringify({ cached: true }), {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "max-age=60",
    }),
  "/api/abort": (response) => response.destroy(),
  "/api/download": (response) =>
    send(response, 200, "RECnRun fixture download\n", {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="recnrun-fixture.txt"',
    }),
};

async function submit(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    methodNotAllowed(response, "POST");
    return;
  }
  const body = await readBody(request, MAX_FORM_BYTES);
  if (body === undefined) {
    sendText(response, 413, "Form too large\n");
    return;
  }
  redirect(response, 303, `/routes/submit-result?${new URLSearchParams(body).toString()}`);
}

function redirectHop(response: ServerResponse, hops: number): void {
  if (hops < 1 || hops > MAX_REDIRECT_HOPS) {
    sendJson(response, 404, { ok: false, error: "Not found" });
    return;
  }
  redirect(response, 302, hops === 1 ? "/api/json" : `/api/redirect/${hops - 1}`);
}

export async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ApiContext,
): Promise<void> {
  if (url.pathname === "/api/submit") return submit(request, response);
  if (url.pathname === "/api/orders") return handleOrders(request, response, url, context.orders);
  const hops = /^\/api\/redirect\/(\d+)$/.exec(url.pathname)?.[1];
  if (hops !== undefined) return redirectHop(response, Number(hops));
  const handler = GET_HANDLERS[url.pathname];
  if (!handler) return sendJson(response, 404, { ok: false, error: "Not found" });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed(response, "GET, HEAD");
  }
  return handler(response, url, context);
}
