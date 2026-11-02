import type { OutgoingHttpHeaders, ServerResponse } from "node:http";

const BASE_HEADERS: OutgoingHttpHeaders = {
  "X-Content-Type-Options": "nosniff",
  // Tests reload pages and expect the fixture's current answer, never a cached one.
  "Cache-Control": "no-store",
};

export function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: OutgoingHttpHeaders = {},
): void {
  response.writeHead(status, { ...BASE_HEADERS, ...headers });
  response.end(body);
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), {
    "Content-Type": "application/json; charset=utf-8",
  });
}

export function sendText(response: ServerResponse, status: number, text: string): void {
  send(response, status, text, { "Content-Type": "text/plain; charset=utf-8" });
}

export function redirect(response: ServerResponse, status: 302 | 303, location: string): void {
  send(response, status, "", { Location: location });
}

export function startStream(response: ServerResponse, contentType: string): void {
  response.writeHead(200, { ...BASE_HEADERS, "Content-Type": contentType });
}

export function methodNotAllowed(response: ServerResponse, allow: string): void {
  send(response, 405, "Method not allowed\n", {
    Allow: allow,
    "Content-Type": "text/plain; charset=utf-8",
  });
}
