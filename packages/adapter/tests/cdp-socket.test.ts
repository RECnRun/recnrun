import { expect, test } from "vite-plus/test";
import { openCdpChannel, type CdpEvent } from "../src/cdp-socket.ts";
import { FakeSocket } from "./fake-socket.ts";

const ENDPOINT = "ws://127.0.0.1:9222/devtools/browser/x";

async function open() {
  let socket: FakeSocket | undefined;
  const opening = openCdpChannel(ENDPOINT, (url) => {
    socket = new FakeSocket(url);
    return socket;
  });
  if (!socket) throw new Error("no socket");
  socket.emit("open");
  return { channel: await opening, socket };
}

test("sends numbered commands, with the session when given, and settles each by its reply", async () => {
  const { channel, socket } = await open();
  const first = channel.send("Target.setAutoAttach", { autoAttach: true });
  const second = channel.send("Runtime.enable", undefined, "S1");
  expect(socket.sent).toEqual([
    { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } },
    { id: 2, method: "Runtime.enable", params: {}, sessionId: "S1" },
  ]);
  socket.emit("message", JSON.stringify({ id: 2, error: { message: "Not allowed" } }));
  socket.emit("message", JSON.stringify({ id: 1 }));
  socket.emit("message", JSON.stringify({ id: 9, result: {} }));
  await expect(first).resolves.toEqual({});
  await expect(second).rejects.toThrow("Runtime.enable failed: Not allowed");
});

test("delivers events with their session and skips malformed messages", async () => {
  const { channel, socket } = await open();
  const events: CdpEvent[] = [];
  channel.onEvent((event) => events.push(event));
  socket.emit("message", "not json");
  socket.emit("message", JSON.stringify({ method: 42 }));
  socket.emit("message", JSON.stringify({ method: "Target.targetCreated" }));
  socket.emit(
    "message",
    JSON.stringify({ method: "Runtime.bindingCalled", params: { name: "b" }, sessionId: "S1" }),
  );
  expect(events).toEqual([
    { method: "Target.targetCreated", params: {} },
    { method: "Runtime.bindingCalled", params: { name: "b" }, sessionId: "S1" },
  ]);
});

test("closing rejects pending and later commands and closes the socket", async () => {
  const { channel, socket } = await open();
  const pending = channel.send("Target.getTargets");
  channel.close();
  expect(socket.closed).toBe(true);
  await expect(pending).rejects.toThrow(`CDP socket to ${ENDPOINT} closed.`);
  await expect(channel.send("Target.getTargets")).rejects.toThrow("closed");
});

test("the socket failing rejects what is pending", async () => {
  const { channel, socket } = await open();
  const pending = channel.send("Target.getTargets");
  socket.emit("error");
  await expect(pending).rejects.toThrow("closed");
});

test("rejects when nothing answers at the endpoint", async () => {
  const opening = openCdpChannel(ENDPOINT, (url) => {
    const socket = new FakeSocket(url);
    queueMicrotask(() => socket.emit("error"));
    return socket;
  });
  await expect(opening).rejects.toThrow(`No CDP endpoint answered at ${ENDPOINT}.`);
});

function opening(play: (socket: FakeSocket) => void) {
  const sockets: FakeSocket[] = [];
  const channel = openCdpChannel(
    ENDPOINT,
    (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => play(socket));
      return socket;
    },
    20,
  );
  return { channel, sockets };
}

test(
  "rejects with open-timeout and closes a socket that never opens",
  { timeout: 1_000 },
  async () => {
    const { channel, sockets } = opening(() => undefined);
    await expect(channel).rejects.toMatchObject({
      code: "open-timeout",
      message: `${ENDPOINT} did not open within 20 ms.`,
    });
    expect(sockets[0]?.closed).toBe(true);
  },
);

test(
  "rejects with closed-before-open when the socket closes first",
  { timeout: 1_000 },
  async () => {
    const { channel } = opening((socket) => socket.emit("close"));
    await expect(channel).rejects.toMatchObject({ code: "closed-before-open" });
  },
);

test("an opened socket outlives the open deadline", async () => {
  const { channel, sockets } = opening((socket) => socket.emit("open"));
  const open = await channel;
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(sockets[0]?.closed).toBe(false);
  const reply = open.send("Target.getTargets");
  sockets[0]?.emit("message", JSON.stringify({ id: 1, result: { targetInfos: [] } }));
  await expect(reply).resolves.toEqual({ targetInfos: [] });
});
