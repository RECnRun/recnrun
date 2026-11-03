import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { ResponseEnvelope } from "@recnrun/protocol";
import { authorize, checkSource, presentedToken, tokenMatches, type Guard } from "./auth.ts";
import {
  dispatch,
  failure,
  UNKNOWN_REQUEST_ID,
  type CommandHandlers,
  type PushChannel,
} from "./dispatch.ts";
import type { Logger } from "./logger.ts";
import { isUiPath, serveUi } from "./static.ts";
import { acceptWebSocket, CLOSE, refuseUpgrade, type WebSocketChannel } from "./websocket.ts";

/** A request body larger than this is refused with 413. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface ApiContext {
  guard: Guard;
  handlers: CommandHandlers;
  logger: Logger;
  /** The built UI (`apps/ui/dist`) served on `GET /` and `GET /assets/*`. */
  uiRoot: string;
}

export interface ApiServer {
  readonly server: Server;
  /** Closes every WebSocket (1001) and every connection, and stops listening. */
  close(): Promise<void>;
}

const pathOf = (url: string | undefined) => new URL(url ?? "/", "http://127.0.0.1").pathname;

function sendJson(
  response: ServerResponse,
  status: number,
  body: ResponseEnvelope,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

const statusOf = (envelope: ResponseEnvelope) => {
  if (envelope.ok) return 200;
  if (envelope.error.code === "invalid-request") return 400;
  return envelope.error.code === "internal" ? 500 : 200;
};

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

/** The UI's own page and files: `Host` and `Origin` are checked, the token is what they hand out. */
async function handleUi(request: IncomingMessage, response: ServerResponse, context: ApiContext) {
  const source = checkSource(request.headers, context.guard);
  if (!source.ok)
    return sendJson(response, 403, failure(UNKNOWN_REQUEST_ID, source.code, source.message));
  await serveUi(context.uiRoot, pathOf(request.url), context.guard.token, response);
}

/** Routes `POST /api` to the dispatcher once the caller passed `Host`, `Origin`, and the token. */
async function handleHttp(request: IncomingMessage, response: ServerResponse, context: ApiContext) {
  if (request.method === "GET" && isUiPath(pathOf(request.url)))
    return handleUi(request, response, context);
  const verdict = authorize(request, context.guard, false);
  if (!verdict.ok) {
    const challenge: Record<string, string> =
      verdict.status === 401 ? { "www-authenticate": "Bearer" } : {};
    return sendJson(
      response,
      verdict.status,
      failure(UNKNOWN_REQUEST_ID, verdict.code, verdict.message),
      challenge,
    );
  }
  if (pathOf(request.url) !== "/api")
    return sendJson(response, 404, failure(UNKNOWN_REQUEST_ID, "not-found", "Use POST /api."));
  if (request.method !== "POST")
    return sendJson(
      response,
      405,
      failure(UNKNOWN_REQUEST_ID, "invalid-request", "Use POST /api."),
      { allow: "POST" },
    );
  const body = await readBody(request);
  if (body === undefined)
    return sendJson(
      response,
      413,
      failure(UNKNOWN_REQUEST_ID, "invalid-request", "The body is too large."),
    );
  const json = parseJson(body);
  const envelope = json.ok
    ? await dispatch(json.value, context.handlers)
    : failure(UNKNOWN_REQUEST_ID, "invalid-request", "The body is not JSON.");
  sendJson(response, statusOf(envelope), envelope);
}

async function answer(channel: WebSocketChannel, text: string, handlers: CommandHandlers) {
  const json = parseJson(text);
  const envelope = json.ok
    ? await dispatch(json.value, handlers, pushTo(channel))
    : failure(UNKNOWN_REQUEST_ID, "invalid-request", "The message is not JSON.");
  channel.send(JSON.stringify(envelope));
}

const pushTo = (channel: WebSocketChannel): PushChannel => ({
  push: (message) => {
    if (!channel.closed) channel.send(JSON.stringify(message));
  },
  onClose: (listener) => channel.onClose(listener),
});

/** `/ws`: `Host` and `Origin` are refused with 403 before the handshake; a bad token closes 4401. */
function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  context: ApiContext & { channels: Set<WebSocketChannel> },
): void {
  socket.on("error", () => socket.destroy());
  if (!checkSource(request.headers, context.guard).ok)
    return refuseUpgrade(socket, 403, "Forbidden");
  if (pathOf(request.url) !== "/ws") return refuseUpgrade(socket, 404, "Not Found");
  const channel = acceptWebSocket(request, socket);
  if (channel === undefined) return;
  // Browsers cannot set headers on a WebSocket, so `?token=` is accepted here only.
  if (!tokenMatches(presentedToken(request.headers, request.url, true), context.guard.token)) {
    context.logger.warn("ws.unauthorized");
    return channel.close(CLOSE.unauthorized, "unauthorized");
  }
  context.channels.add(channel);
  socket.on("close", () => context.channels.delete(channel));
  channel.start(head, (text) => void answer(channel, text, context.handlers));
}

/** The loopback API: JSON envelopes over `POST /api` and over the `/ws` WebSocket. */
export function createApiServer(context: ApiContext): ApiServer {
  const channels = new Set<WebSocketChannel>();
  const server = createServer((request, response) => {
    const started = Date.now();
    response.on("finish", () =>
      context.logger.info("http", {
        method: request.method,
        path: pathOf(request.url),
        status: response.statusCode,
        ms: Date.now() - started,
      }),
    );
    handleHttp(request, response, context).catch((error: unknown) => {
      context.logger.error("http.failed", { message: String(error) });
      response.destroy();
    });
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) =>
    handleUpgrade(request, socket, head, { ...context, channels }),
  );
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        for (const channel of channels) channel.close(CLOSE.goingAway, "service stopping");
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
