import { expect, test } from "vite-plus/test";
import { rawCdpCall, type RawSocket } from "../src/raw-cdp.ts";

type Listener = (event: { data?: unknown }) => void;

class FakeSocket implements RawSocket {
  readonly sent: unknown[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

function call(timeoutMs = 1_000) {
  let socket: FakeSocket | undefined;
  const result = rawCdpCall("ws://127.0.0.1:9222/devtools/browser/x", "Target.getTargets", {
    timeoutMs,
    createSocket: (url) => {
      socket = new FakeSocket(url);
      return socket;
    },
  });
  if (!socket) throw new Error("no socket");
  return { result, socket };
}

test("sends the command once open and resolves its result", async () => {
  const { result, socket } = call();
  socket.emit("open");
  expect(socket.sent).toEqual([{ id: 1, method: "Target.getTargets", params: {} }]);
  socket.emit("message", JSON.stringify({ method: "Target.targetCreated", params: {} }));
  socket.emit("message", JSON.stringify({ id: 1, result: { targetInfos: [] } }));
  await expect(result).resolves.toEqual({ targetInfos: [] });
  expect(socket.closed).toBe(true);
});

test("rejects with the error Chrome answers", async () => {
  const { result, socket } = call();
  socket.emit("open");
  socket.emit(
    "message",
    JSON.stringify({ id: 1, error: { code: -32601, message: "'X' wasn't found" } }),
  );
  await expect(result).rejects.toThrow("Target.getTargets failed: 'X' wasn't found");
  expect(socket.closed).toBe(true);
});

test("rejects when the socket fails or closes first", async () => {
  const failed = call();
  failed.socket.emit("error");
  await expect(failed.result).rejects.toThrow(
    /No CDP endpoint answered at ws:\/\/127\.0\.0\.1:9222/,
  );
  const closed = call();
  closed.socket.emit("open");
  closed.socket.emit("close");
  await expect(closed.result).rejects.toThrow(/No CDP endpoint answered/);
});

test("rejects after the timeout", async () => {
  const { result, socket } = call(5);
  await expect(result).rejects.toThrow(/did not answer within 5 ms/);
  expect(socket.closed).toBe(true);
});
