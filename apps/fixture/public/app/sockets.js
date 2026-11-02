import { API, attempt, firstPaint, marker, show } from "./page.js";

await marker("sockets:start");

function echo(message) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${API.replace("http:", "ws:")}/ws`);
    socket.onopen = () => socket.send(message);
    socket.onmessage = (event) => {
      resolve(event.data);
      socket.close();
    };
    socket.onerror = () => reject(new Error("WebSocket failed"));
  });
}

function firstEvent() {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`${API}/events`, { withCredentials: true });
    source.addEventListener("hello", (event) => {
      resolve(JSON.parse(event.data));
      source.close();
    });
    source.onerror = () => {
      source.close();
      reject(new Error("EventSource failed"));
    };
  });
}

const report = {
  webSocket: await attempt(() => echo("ping")),
  eventSource: await attempt(firstEvent),
};

show("report", report);
await firstPaint("sockets");
