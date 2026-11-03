import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

/**
 * A minimal CDP client with flattened sessions. Playwright's `CDPSession` cannot address child
 * sessions or speak over `--remote-debugging-pipe`, and both are needed to reach extensions.
 */
interface SendOptions {
  /** Rejects the command when Chrome has not replied by then; 30 s by default. */
  timeoutMs?: number;
}

export interface CdpClient {
  send<T = unknown>(
    method: string,
    params?: object,
    sessionId?: string,
    options?: SendOptions,
  ): Promise<T>;
  /** Closes the transport and rejects every pending command. */
  close(): void;
}

/** The transport closed, failed, or ended, or the client was closed, before Chrome replied. */
export class CdpClosedError extends Error {
  constructor(method: string) {
    super(`${method}: CDP connection closed`);
  }
}

interface Reply {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

interface Waiter {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

const TARGET_POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

function createClient(write: (message: string) => void, closeTransport: () => void) {
  const pending = new Map<number, Waiter>();
  let closed = false;
  let nextId = 0;
  const take = (id: number): Waiter | undefined => {
    const waiter = pending.get(id);
    pending.delete(id);
    if (waiter) clearTimeout(waiter.timer);
    return waiter;
  };
  const receive = (raw: string): void => {
    const reply = JSON.parse(raw) as Reply;
    const waiter = reply.id === undefined ? undefined : take(reply.id);
    if (!waiter) return;
    if (reply.error) waiter.reject(new Error(`${waiter.method}: ${reply.error.message}`));
    else waiter.resolve(reply.result);
  };
  const disconnect = (): void => {
    closed = true;
    for (const [id, waiter] of pending) {
      take(id);
      waiter.reject(new CdpClosedError(waiter.method));
    }
  };
  const send = <T>(method: string, params = {}, sessionId?: string, options: SendOptions = {}) =>
    new Promise<T>((resolve, reject) => {
      if (closed) throw new CdpClosedError(method);
      const id = ++nextId;
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const expire = () =>
        take(id)?.reject(new Error(`${method}: no reply within ${timeoutMs} ms`));
      // A stranded command must not keep the test process alive on its own.
      const timer = setTimeout(expire, timeoutMs).unref();
      pending.set(id, { method, timer, resolve: (value) => resolve(value as T), reject });
      write(JSON.stringify({ id, method, params, sessionId }));
    });
  const close = (): void => {
    disconnect();
    closeTransport();
  };
  return { client: { send, close } satisfies CdpClient, receive, disconnect };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Refuses any endpoint off the loopback: the harness never reaches another host's browser. */
export function requireLoopback(url: string): void {
  const { protocol, hostname } = new URL(url);
  if (protocol !== "ws:" || !LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`CDP endpoint ${url} is not a ws:// address on the loopback`);
  }
}

export async function connectWebSocket(url: string): Promise<CdpClient> {
  requireLoopback(url);
  const socket = new WebSocket(url);

  const { client, receive, disconnect } = createClient(
    (message) => socket.send(message),
    () => socket.close(),
  );
  socket.addEventListener("message", (event) => receive(String(event.data)));
  socket.addEventListener("close", disconnect);
  socket.addEventListener("error", disconnect);
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
  const { client, receive, disconnect } = createClient(
    (message) => input.write(`${message}\0`),
    () => input.end(),
  );
  // Chrome exiting ends fd 4 and breaks fd 3; either one strands every pending command.
  for (const event of ["end", "close", "error"]) output.on(event, disconnect);
  for (const event of ["close", "error"]) input.on(event, disconnect);
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
    const { targetInfos } = await client.send<{ targetInfos: TargetInfo[] }>(
      "Target.getTargets",
      {},
      undefined,
      { timeoutMs },
    );
    const worker = targetInfos.find(
      (target) => target.type === "service_worker" && target.url.startsWith(prefix),
    );
    if (worker) return worker;
    await delay(TARGET_POLL_MS);
  }
  throw new Error(`No service worker target for ${prefix} within ${timeoutMs} ms`);
}

/**
 * Evaluates `expression` (awaiting a promise) in the extension's service worker and returns its
 * value. `timeoutMs` bounds finding and attaching to the worker; the evaluation keeps the default
 * per-command deadline, since probes can run longer.
 */
export async function evaluateInServiceWorker(
  client: CdpClient,
  extensionId: string,
  expression: string,
  timeoutMs = 10_000,
): Promise<unknown> {
  const { targetId } = await waitForServiceWorker(client, extensionId, timeoutMs);
  const { sessionId } = await client.send<{ sessionId: string }>(
    "Target.attachToTarget",
    { targetId, flatten: true },
    undefined,
    { timeoutMs },
  );
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
