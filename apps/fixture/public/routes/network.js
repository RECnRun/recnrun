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

const LARGE_BYTES = 200_000;
const LONG_FRAME_LENGTH = 5_000;
const SSE_EVENTS = 3;

async function large() {
  const text = await (await fetch(`/api/large?bytes=${LARGE_BYTES}`)).text();
  return `${text.length} bytes`;
}

async function secret() {
  const headers = { Authorization: "Bearer s3cr3t-token" };
  const body = await (await fetch("/api/secret", { headers })).json();
  return body.authorized ? "authorized" : "not authorized";
}

async function cached() {
  const body = await (await fetch("/api/cached")).json();
  return body.cached ? "cached answer" : "unexpected answer";
}

async function abort() {
  await fetch("/api/abort");
  return "answered";
}

function echo(sends) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/echo`);
    socket.binaryType = "arraybuffer";
    const received = [];
    socket.addEventListener("open", () => sends.forEach((data) => socket.send(data)));
    socket.addEventListener("message", (event) => {
      received.push(event.data);
      if (received.length < sends.length) return;
      socket.close();
      resolve(received);
    });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
  });
}

async function frames() {
  const echoed = await echo([
    "hello fixture",
    new Uint8Array([1, 2, 3]),
    "x".repeat(LONG_FRAME_LENGTH),
  ]);
  return `${echoed.length} frames echoed`;
}

function events() {
  return new Promise((resolve, reject) => {
    const source = new EventSource("/api/events");
    const received = [];
    const take = (event) => {
      received.push(event.data);
      if (received.length < SSE_EVENTS) return;
      source.close();
      resolve(`${received.length} events`);
    };
    source.addEventListener("message", take);
    source.addEventListener("tick", take);
    source.addEventListener("error", () => {
      source.close();
      reject(new Error("EventSource failed"));
    });
  });
}

async function websocket() {
  const [reply] = await echo(["hello fixture"]);
  return `echo: ${reply}`;
}

const CASES = {
  json,
  binary,
  error,
  redirect,
  stream,
  websocket,
  large,
  secret,
  cached,
  abort,
  frames,
  events,
};

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
