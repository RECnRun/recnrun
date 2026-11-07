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

/** A click the W7 fixture saw: the element id it landed on and where, in CSS pixels. */
interface Hit {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  path: string;
}

export interface Target {
  origin: string;
  posts: Post[];
  hits: Hit[];
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
<script>const ms=Math.min(Number(new URLSearchParams(location.search).get("ms")??8000),60000);
setTimeout(()=>{const p=document.createElement("p");p.id="late";document.body.append(p);},ms)</script>`,
  "/visual/static": `<!doctype html><meta charset="utf-8"><title>Static</title>${VISUAL_STYLE}
<html style="--panel:#808080"><body><p id="static">static</p>`,
};

// W7 slice B: targets laid out in fractions of the viewport, so a frame's geometry locates them.
const INTERACT_STYLE = `<style>html,body{margin:0;height:100%;font:20px sans-serif;background:var(--panel)}
.t{position:fixed;display:flex;align-items:center;justify-content:center;background:#fff;border:0;margin:0}
.c{width:40px;height:40px;background:#000}
#count{left:40%;top:40%;width:20%;height:20%}#next{left:5%;top:45%;width:20%;height:10%}
#away{left:75%;top:45%;width:20%;height:10%}#popup{left:40%;top:75%;width:20%;height:10%}
#tl{left:0;top:0}#tr{right:0;top:0}#bl{left:0;bottom:0}#br{right:0;bottom:0}
.spin{position:fixed;left:48%;top:10%;width:4%;height:6%;background:#000;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}</style>`;

const INTERACT_SCRIPT = `<script>let n=0;document.getElementById("count")?.addEventListener("click",()=>{
n+=1;document.getElementById("count").textContent=String(n);});
document.addEventListener("click",(e)=>{const id=e.target.closest("[id]")?.id??"body";
fetch("/interact/hit",{method:"POST",keepalive:true,body:JSON.stringify({id,x:e.clientX,y:e.clientY,
w:innerWidth,h:innerHeight,path:location.pathname})});});</script>`;

const CORNERS = `<div id="tl" class="t c"></div><div id="tr" class="t c"></div>
<div id="bl" class="t c"></div><div id="br" class="t c"></div><div class="spin"></div>`;

const INTERACT: Record<string, string> = {
  "/interact": `<!doctype html><meta charset="utf-8"><title>Interact</title>${INTERACT_STYLE}
<html style="--panel:#2050c0"><body><button id="count" class="t" type="button">0</button>
<a id="next" class="t" href="/interact/next">next</a><a id="away" class="t" href="/visual/away">away</a>
<a id="popup" class="t" href="/interact/next" target="_blank" rel="opener">popup</a>${CORNERS}${INTERACT_SCRIPT}`,
  "/interact/next": `<!doctype html><meta charset="utf-8"><title>Next</title>${INTERACT_STYLE}
<html style="--panel:#20a040"><body><button id="count" class="t" type="button">0</button>
${CORNERS}${INTERACT_SCRIPT}`,
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
  const body = pages[url.pathname]?.() ?? VISUAL[url.pathname] ?? INTERACT[url.pathname];
  if (body === undefined) return false;
  response.writeHead(200, HTML).end(body);
  return true;
}

/** The W7 fixture's click reports; anything malformed is dropped. */
function servedHit(request: IncomingMessage, response: ServerResponse, hits: Hit[]): boolean {
  if (request.method !== "POST" || request.url !== "/interact/hit") return false;
  void bodyOf(request)
    .then((body) => {
      hits.push(JSON.parse(body) as Hit);
      response.writeHead(204).end();
    })
    .catch(() => response.writeHead(400).end());
  return true;
}

function handler(posts: Post[], hits: Hit[]) {
  return (request: IncomingMessage, response: ServerResponse) => {
    if (servedGet(request, response) || servedHit(request, response, hits)) return;
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
  const hits: Hit[] = [];
  const server = createServer(handler(posts, hits));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    posts,
    hits,
    count: (text) => posts.filter((post) => post.text === text).length,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
