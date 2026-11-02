import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

/**
 * A minimal CDP client with flattened sessions. Playwright's `CDPSession` cannot address child
 * sessions or speak over `--remote-debugging-pipe`, and both are needed to reach extensions.
 */
export interface CdpClient {
  send<T = unknown>(method: string, params?: object, sessionId?: string): Promise<T>;
  close(): void;
}

interface Reply {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

const TARGET_POLL_MS = 100;

function createClient(write: (message: string) => void, close: () => void) {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0;
  const receive = (raw: string): void => {
    const reply = JSON.parse(raw) as Reply;
    const waiter = reply.id === undefined ? undefined : pending.get(reply.id);
    if (!waiter || reply.id === undefined) return;
    pending.delete(reply.id);
    if (reply.error) waiter.reject(new Error(reply.error.message));
    else waiter.resolve(reply.result);
  };
  const client: CdpClient = {
    send: <T>(method: string, params: object = {}, sessionId?: string) =>
      new Promise<T>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject: (error) => reject(new Error(`${method}: ${error.message}`)),
        });
        write(JSON.stringify({ id, method, params, sessionId }));
      }),
    close,
  };
  return { client, receive };
}

export async function connectWebSocket(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url);
  const { client, receive } = createClient(
    (message) => socket.send(message),
    () => socket.close(),
  );
  socket.addEventListener("message", (event) => receive(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)), {
      once: true,
    });
  });
  return client;
}

/** CDP over `--remote-debugging-pipe`: Chrome reads fd 3 and writes fd 4, messages end in NUL. */
export function connectPipe(input: Writable, output: Readable): CdpClient {
  const { client, receive } = createClient(
    (message) => input.write(`${message}\0`),
    () => input.end(),
  );
  let buffer = "";
  output.on("data", (data) => {
    buffer += String(data);
    let end = buffer.indexOf("\0");
    while (end >= 0) {
      receive(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\0");
    }
  });
  return client;
}

async function waitForServiceWorker(
  client: CdpClient,
  extensionId: string,
  timeoutMs: number,
): Promise<TargetInfo> {
  const prefix = `chrome-extension://${extensionId}/`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await client.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    const worker = targetInfos.find(
      (target) => target.type === "service_worker" && target.url.startsWith(prefix),
    );
    if (worker) return worker;
    await delay(TARGET_POLL_MS);
  }
  throw new Error(`No service worker target for ${prefix} within ${timeoutMs} ms`);
}

/** Evaluates `expression` (awaiting a promise) in the extension's service worker and returns its value. */
export async function evaluateInServiceWorker(
  client: CdpClient,
  extensionId: string,
  expression: string,
  timeoutMs = 10_000,
): Promise<unknown> {
  const { targetId } = await waitForServiceWorker(client, extensionId, timeoutMs);
  const { sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  try {
    const evaluation = await client.send<{
      result: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string }; text: string };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    const failure = evaluation.exceptionDetails;
    if (failure) throw new Error(failure.exception?.description ?? failure.text);
    return evaluation.result.value;
  } finally {
    await client.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}
