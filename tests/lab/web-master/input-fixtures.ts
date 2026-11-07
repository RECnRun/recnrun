import type { IncomingMessage, ServerResponse } from "node:http";

/*
 * W7 slice C fixtures: a form whose field takes typed text and a page tall enough to scroll,
 * with an inner container. Each page reports keys, buttons, submits, and scroll positions.
 */

/** What a fixture page reported, with the time the report arrived. */
export interface InputReport {
  type: string;
  at: number;
  key?: string;
  button?: number;
  held?: string[] | number;
  n?: number;
  value?: string;
  page?: number;
  inner?: number;
}

const STYLE = `<style>html,body{margin:0;font:24px sans-serif;background:#2050c0}
#field{position:fixed;left:10%;top:30%;width:60%;height:15%;font:32px sans-serif}
#submits{position:fixed;left:75%;top:30%;color:#fff}
.spin{position:fixed;left:48%;top:5%;width:4%;height:6%;background:#000;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
#inner{position:fixed;left:55%;top:20%;width:40%;height:60%;overflow:auto;overscroll-behavior:contain;background:#fff}
#tall{height:5000px}#inner-tall{height:3000px}</style>`;

const REPORT = `<script>const report=(body)=>fetch("/interact/event",{method:"POST",keepalive:true,
body:JSON.stringify(body)});const keys=new Set();
addEventListener("keydown",(e)=>{keys.add(e.key);report({type:"keydown",key:e.key,held:[...keys]});},true);
addEventListener("keyup",(e)=>{keys.delete(e.key);report({type:"keyup",key:e.key,held:[...keys]});},true);
addEventListener("mousedown",(e)=>report({type:"mousedown",button:e.button,held:e.buttons}),true);
addEventListener("mouseup",(e)=>report({type:"mouseup",button:e.button,held:e.buttons}),true);</script>`;

const FORM_SCRIPT = `<script>let n=0;document.getElementById("form").addEventListener("submit",(e)=>{
e.preventDefault();n+=1;document.getElementById("submits").textContent=String(n);
report({type:"submit",n,value:document.getElementById("field").value});});</script>`;

const SCROLL_SCRIPT = `<script>const inner=document.getElementById("inner");
const where=()=>report({type:"scroll",page:scrollY,inner:inner.scrollTop});
addEventListener("scroll",where);inner.addEventListener("scroll",where);</script>`;

export const INPUT_PAGES: Record<string, string> = {
  "/interact/form": `<!doctype html><meta charset="utf-8"><title>Form</title>${STYLE}${REPORT}
<body><form id="form"><input id="field" name="field" autocomplete="off"></form>
<span id="submits">0</span><div class="spin"></div>${FORM_SCRIPT}`,
  "/interact/scroll": `<!doctype html><meta charset="utf-8"><title>Scroll</title>${STYLE}${REPORT}
<body><div id="tall"></div><div id="inner"><div id="inner-tall"></div></div>
<div class="spin"></div>${SCROLL_SCRIPT}`,
};

/** The fixture pages' reports; anything malformed is dropped. */
export function servedReport(
  request: IncomingMessage,
  response: ServerResponse,
  reports: InputReport[],
): boolean {
  if (request.method !== "POST" || request.url !== "/interact/event") return false;
  void (async () => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    reports.push({ ...(JSON.parse(body) as object), at: Date.now() } as InputReport);
    response.writeHead(204).end();
  })().catch(() => response.writeHead(400).end());
  return true;
}
