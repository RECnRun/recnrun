// Request and response helpers the fixture server's route modules share.
import type { IncomingMessage, ServerResponse } from "node:http";

export const HTML = "text/html; charset=utf-8";
export const JS = "text/javascript";
export const JSON_TYPE = "application/json";

/** One request as a route sees it; `run` comes from `?run=` or the `run` cookie. */
export interface Exchange {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  host: string;
  run: string | undefined;
}

export function cookiesOf(request: IncomingMessage): Record<string, string> {
  const pairs = (request.headers.cookie ?? "").split(/;\s*/).filter(Boolean);
  return Object.fromEntries(
    pairs.map((pair) => {
      const [name = "", ...value] = pair.split("=");
      return [name, value.join("=")];
    }),
  );
}

export function send(response: ServerResponse, type: string, body: string, headers = {}): void {
  response.writeHead(200, { "content-type": type, "cache-control": "no-store", ...headers });
  response.end(body);
}

/** A 302 to `location`, never cached. */
export function redirectTo(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, "cache-control": "no-store" });
  response.end();
}

export async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
