import { REPORT } from "./input-fixtures.ts";

/*
 * W7 slice D fixtures: a range input and a canvas drawn by drag (I4), an HTML5 draggable list
 * (I5), and a block whose presses draw their count in binary cells (latency). Each page reports
 * its layout.
 */

const LAYOUT = `<script>const rect=(el)=>{const r=el.getBoundingClientRect();
return {left:r.left,top:r.top,width:r.width,height:r.height};};
const layout=(ids)=>report({type:"layout",path:location.pathname,w:innerWidth,h:innerHeight,
rects:Object.fromEntries(ids.map((id)=>[id,rect(document.getElementById(id))]))});
addEventListener("pointerup",(e)=>report({type:"pointerup",button:e.button}),true);</script>`;

const DRAG_STYLE = `<style>html,body{margin:0;height:100%;background:#2050c0;font:20px sans-serif}
#slider{position:fixed;left:10%;top:12%;width:60%;height:24px;margin:0;-webkit-appearance:none;background:#ccc}
#slider::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:24px;background:#000}
#value{position:fixed;left:75%;top:12%;color:#fff}
#canvas{position:fixed;left:10%;top:40%;width:60%;height:45%;background:#fff;touch-action:none}
.spin{position:fixed;left:85%;top:50%;width:4%;height:6%;background:#000;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}</style>`;

// The slider reports every value and its one change; the canvas reports each finished stroke.
const DRAG_SCRIPT = `<script>const slider=document.getElementById("slider");
slider.addEventListener("input",()=>{document.getElementById("value").textContent=slider.value;
report({type:"input",value:Number(slider.value)});});
slider.addEventListener("change",()=>report({type:"change",value:Number(slider.value)}));
const canvas=document.getElementById("canvas");const box=canvas.getBoundingClientRect();
canvas.width=box.width;canvas.height=box.height;const g=canvas.getContext("2d");
g.lineWidth=6;g.strokeStyle="#e01010";let points=null;
const at=(e)=>({x:Math.round(e.clientX-box.left),y:Math.round(e.clientY-box.top)});
canvas.addEventListener("pointerdown",(e)=>{canvas.setPointerCapture(e.pointerId);points=[at(e)];
g.beginPath();g.moveTo(points[0].x,points[0].y);report({type:"strokestart"});});
canvas.addEventListener("pointermove",(e)=>{if(!points)return;const p=at(e);points.push(p);
g.lineTo(p.x,p.y);g.stroke();});
canvas.addEventListener("pointerup",(e)=>{if(!points)return;points.push(at(e));
report({type:"stroke",points});points=null;});
layout(["slider","canvas"]);</script>`;

const LIST_STYLE = `<style>html,body{margin:0;height:100%;background:#2050c0;font:24px sans-serif}
#list{position:fixed;left:10%;top:10%;width:40%;margin:0;padding:0;list-style:none}
#list li{height:70px;margin:0 0 10px;background:#fff;display:flex;align-items:center;padding-left:16px}
.spin{position:fixed;left:85%;top:50%;width:4%;height:6%;background:#000;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}</style>`;

// The dragged item moves after the target when dropped on its lower half, before it otherwise.
const LIST_SCRIPT = `<script>const list=document.getElementById("list");
const order=()=>[...list.children].map((li)=>li.id);
for(const li of list.children){
li.addEventListener("dragstart",(e)=>{e.dataTransfer.setData("text/plain",li.id);
e.dataTransfer.effectAllowed="move";report({type:"dragstart",id:li.id});});
li.addEventListener("dragover",(e)=>{e.preventDefault();e.dataTransfer.dropEffect="move";});
li.addEventListener("drop",(e)=>{e.preventDefault();const id=e.dataTransfer.getData("text/plain");
const source=document.getElementById(id);const r=li.getBoundingClientRect();
if(source&&source!==li){if(e.clientY>r.top+r.height/2)li.after(source);else li.before(source);}
report({type:"drop",data:id,types:[...e.dataTransfer.types],order:order()});});
li.addEventListener("dragend",(e)=>report({type:"dragend",id:li.id,dropEffect:e.dataTransfer.dropEffect}));}
layout(["i1","i2","i3","i4"]);</script>`;

// Each press draws its count, mod 256, in eight black and white cells the master decodes.
const CELLS = Array.from({ length: 8 }, (_, bit) => `b${bit}`);
const LATENCY_SCRIPT = `<script>const cells=${JSON.stringify(CELLS)};let n=0;
addEventListener("mousedown",()=>{n+=1;cells.forEach((id,bit)=>{
document.getElementById(id).style.background=(n>>bit)&1?"#fff":"#000";});
report({type:"press",n});},true);layout(["block",...cells]);</script>`;
const LATENCY_CELLS = CELLS.map(
  (id, bit) => `<div id="${id}" class="cell" style="left:${10 + bit * 10}%"></div>`,
).join("");

export const DRAG_PAGES: Record<string, string> = {
  "/interact/drag": `<!doctype html><meta charset="utf-8"><title>Drag</title>${DRAG_STYLE}${REPORT}${LAYOUT}
<body><input id="slider" type="range" min="0" max="100" value="0"><span id="value">0</span>
<canvas id="canvas"></canvas><div class="spin"></div>${DRAG_SCRIPT}`,
  "/interact/list": `<!doctype html><meta charset="utf-8"><title>List</title>${LIST_STYLE}${REPORT}${LAYOUT}
<body><ul id="list"><li id="i1" draggable="true">one</li><li id="i2" draggable="true">two</li>
<li id="i3" draggable="true">three</li><li id="i4" draggable="true">four</li></ul>
<div class="spin"></div>${LIST_SCRIPT}`,
  "/interact/latency": `<!doctype html><meta charset="utf-8"><title>Latency</title>${REPORT}${LAYOUT}
<style>html,body{margin:0;height:100%;background:#808080}
#block{position:fixed;left:30%;top:30%;width:40%;height:40%;background:#e01010}
.cell{position:fixed;top:6%;width:8%;height:12%;background:#000}</style>
<body><div id="block"></div>${LATENCY_CELLS}${LATENCY_SCRIPT}`,
};
