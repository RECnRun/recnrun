import { onClick, show, start, withFail } from "../fixture.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

async function json() {
  const response = await fetch(withFail("/api/json"));
  const body = await response.json();
  return `${response.status} ${body.ok ? body.items.join(", ") : body.error}`;
}

async function binary() {
  const response = await fetch("/api/binary");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const png = PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
  const type = response.headers.get("content-type");
  return `${response.status} ${type} ${bytes.length} bytes, ${png ? "PNG" : "not a PNG"}`;
}

async function error() {
  const response = await fetch("/api/error");
  return `${response.status} ${(await response.json()).error}`;
}

async function redirect() {
  const response = await fetch("/api/redirect/3");
  const path = new URL(response.url).pathname;
  return `${response.status} ${response.redirected ? "redirected to" : "at"} ${path}`;
}

async function stream() {
  const started = performance.now();
  const text = await (await fetch(withFail("/api/stream"))).text();
  const chunks = text.trimEnd().split("\n").length;
  return `${chunks} chunks in ${Math.round(performance.now() - started)} ms`;
}

function websocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/echo`);
    socket.addEventListener("open", () => socket.send("hello fixture"));
    socket.addEventListener("message", (event) => {
      resolve(`echo: ${event.data}`);
      socket.close();
    });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
  });
}

const CASES = { json, binary, error, redirect, stream, websocket };

async function run(name, request) {
  show(`result-${name}`, "pending");
  try {
    show(`result-${name}`, await request());
  } catch (failure) {
    show(`result-${name}`, `failed: ${String(failure)}`);
  }
}

for (const [name, request] of Object.entries(CASES)) {
  onClick(`fetch-${name}`, name, () => void run(name, request));
}

await start("network", { counters: Object.keys(CASES) });
