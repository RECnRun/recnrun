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

// W6 visual fixture: solid panels whose colour a probe can read back from a JPEG frame.
const VISUAL_STYLE = `<style>body{margin:0;font:16px sans-serif}
html{background:var(--panel)}
.spin{position:fixed;top:8px;right:8px;width:40px;height:40px;background:#000;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}#modal{position:fixed;top:8px;right:64px;background:#fff;padding:4px}</style>`;

const VISUAL_SCRIPT = `<script>let n=0;document.getElementById("go").addEventListener("click",()=>{
n+=1;document.getElementById("counter").textContent=String(n);
document.getElementById("label").textContent="after";
document.documentElement.style.setProperty("--panel","#e0a020");
document.getElementById("modal").hidden=false;
const after=document.createElement("p");after.id="after";document.body.append(after);});</script>`;

const VISUAL: Record<string, string> = {
  "/visual": `<!doctype html><meta charset="utf-8"><title>Visual</title>${VISUAL_STYLE}
<html style="--panel:#2050c0"><body><button id="go" type="button">Go</button>
<span id="counter">0</span> <span id="label">before</span> <a id="next" href="/visual/second">next</a>
<div class="spin"></div><div id="modal" hidden>modal</div>${VISUAL_SCRIPT}`,
  "/visual/second": `<!doctype html><meta charset="utf-8"><title>Second</title>${VISUAL_STYLE}
<html style="--panel:#20a040"><body><p id="second">second</p><div class="spin"></div>`,
  // W6.16: the fixture's blue panel until `#late` appears, so an observer can join a running job.
  "/visual/late": `<!doctype html><meta charset="utf-8"><title>Late</title>${VISUAL_STYLE}
<html style="--panel:#2050c0"><body><p id="early">early</p><div class="spin"></div>
<script>setTimeout(()=>{const p=document.createElement("p");p.id="late";document.body.append(p);},8000)</script>`,
  "/visual/static": `<!doctype html><meta charset="utf-8"><title>Static</title>${VISUAL_STYLE}
<html style="--panel:#808080"><body><p id="static">static</p>`,
};

const HTML = { "content-type": "text/html; charset=utf-8" };

// W6.07's job takes long enough for its observation to change mode while it runs.
const SLOW_MS = 300;

/** The GET pages; W6.13's `/visual/away` redirects to a host the job never allowed. */
function servedGet(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method !== "GET") return false;
  const url = new URL(request.url ?? "/", "http://lab.invalid");
  if (url.pathname === "/visual/away") {
    const { port } = new URL(`http://${request.headers.host ?? "127.0.0.1"}`);
    response.writeHead(302, { location: `http://localhost:${port}/visual/static` }).end();
    return true;
  }
  if (url.pathname === "/visual/slow") {
    setTimeout(() => response.writeHead(200, HTML).end(VISUAL["/visual/second"]), SLOW_MS);
    return true;
  }
  const pages: Record<string, () => string | undefined> = {
    "/text": () => textPage(url.searchParams),
    "/form": () => FORM,
  };
  const body = pages[url.pathname]?.() ?? VISUAL[url.pathname];
  if (body === undefined) return false;
  response.writeHead(200, HTML).end(body);
  return true;
}

function handler(posts: Post[]) {
  return (request: IncomingMessage, response: ServerResponse) => {
    if (servedGet(request, response)) return;
    if (request.method !== "POST" || request.url !== "/submit") {
      response.writeHead(404).end();
      return;
    }
    void bodyOf(request).then((body) => {
      const text = new URLSearchParams(body).get("text") ?? "";
      posts.push({ text, at: Date.now() });
      response.writeHead(200, HTML).end(page(text));
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
