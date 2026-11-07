import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * The second loopback origin of W.lifecycle: a script-free form whose submit is the job's
 * mutation. The harness counts each POST, with the time it arrived, to prove when it happened.
 */

interface Post {
  text: string;
  at: number;
}

export interface Target {
  origin: string;
  posts: Post[];
  count(text: string): number;
  close(): Promise<void>;
}

const FORM = `<!doctype html><meta charset="utf-8"><title>Lab target</title>
<form method="post" action="/submit"><input id="text" name="text" autocomplete="off">
<button id="send" type="submit">Send</button></form>`;

const page = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>Received</title><p id="result">received ${text}</p>`;

async function bodyOf(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

/** `/text?c=€&n=10000`: a page whose #t holds the character `c` repeated `n` times. */
function textPage(search: URLSearchParams): string {
  const count = Math.min(Number(search.get("n") ?? 0), 200_000);
  const body = (search.get("c") ?? "a").repeat(count);
  return `<!doctype html><meta charset="utf-8"><title>Text</title><p id="t">${body}</p>`;
}

function handler(posts: Post[]) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const html = { "content-type": "text/html; charset=utf-8" };
    const url = new URL(request.url ?? "/", "http://lab.invalid");
    if (request.method === "GET" && url.pathname === "/text") {
      response.writeHead(200, html).end(textPage(url.searchParams));
      return;
    }
    if (request.method === "GET" && request.url === "/form") {
      response.writeHead(200, html).end(FORM);
      return;
    }
    if (request.method !== "POST" || request.url !== "/submit") {
      response.writeHead(404).end();
      return;
    }
    void bodyOf(request).then((body) => {
      const text = new URLSearchParams(body).get("text") ?? "";
      posts.push({ text, at: Date.now() });
      response.writeHead(200, html).end(page(text));
    });
  };
}

export async function startTarget(): Promise<Target> {
  const posts: Post[] = [];
  const server = createServer(handler(posts));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    posts,
    count: (text) => posts.filter((post) => post.text === text).length,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
