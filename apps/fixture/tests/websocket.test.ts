import { expect, test } from "vite-plus/test";
import { useFixture } from "./harness.ts";

const fixture = useFixture();

function connect(path = "/ws/echo"): Promise<WebSocket> {
  const socket = new WebSocket(`${fixture.urls.first.replace("http", "ws")}${path}`);
  socket.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket));
    socket.addEventListener("error", () => reject(new Error(`No WebSocket at ${path}`)));
  });
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => resolve(event.data), { once: true });
  });
}

test("echoes a text message", async () => {
  const socket = await connect();
  const reply = nextMessage(socket);
  socket.send("ping");
  expect(await reply).toBe("ping");
  socket.close();
});

test("echoes a 70 000 byte text message and a binary one", async () => {
  const socket = await connect();
  const long = "x".repeat(70_000);
  let reply = nextMessage(socket);
  socket.send(long);
  expect(await reply).toBe(long);
  reply = nextMessage(socket);
  socket.send(new Uint8Array([1, 2, 3, 250]));
  expect([...new Uint8Array((await reply) as ArrayBuffer)]).toEqual([1, 2, 3, 250]);
  socket.close();
});

test("completes the closing handshake", async () => {
  const socket = await connect();
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
  socket.close(1000, "done");
  const event = await closed;
  expect(event.wasClean).toBe(true);
  expect(event.code).toBe(1000);
});

test("refuses an upgrade on any other path", async () => {
  await expect(connect("/ws/other")).rejects.toThrow("No WebSocket at /ws/other");
});
