import * as v from "valibot";

/** The part of a WebSocket one raw command needs; Node's global WebSocket provides it. */
export interface RawSocket {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface RawCallOptions {
  timeoutMs?: number;
  createSocket?: (url: string) => RawSocket;
}

const ReplySchema = v.object({
  id: v.optional(v.number()),
  result: v.optional(v.unknown()),
  error: v.optional(v.object({ message: v.string() })),
});

const DEFAULT_TIMEOUT_MS = 5_000;

function parseReply(data: unknown): v.InferOutput<typeof ReplySchema> | undefined {
  try {
    const parsed = v.safeParse(ReplySchema, JSON.parse(String(data)));
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

/** Sends one command on its own browser-level socket, so no page session of ours exists yet. */
export function rawCdpCall(
  endpoint: string,
  method: string,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    createSocket = (url) => new WebSocket(url),
  }: RawCallOptions = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(endpoint);
    let settled = false;
    const finish = (error: Error | undefined, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    };
    const gone = () => finish(new Error(`No CDP endpoint answered at ${endpoint}.`));
    const timer = setTimeout(
      () => finish(new Error(`${method} did not answer within ${timeoutMs} ms at ${endpoint}.`)),
      timeoutMs,
    );
    socket.addEventListener("error", gone);
    socket.addEventListener("close", gone);
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ id: 1, method, params: {} })),
    );
    socket.addEventListener("message", ({ data }) => {
      const reply = parseReply(data);
      if (reply?.id !== 1) return;
      if (reply.error) finish(new Error(`${method} failed: ${reply.error.message}`));
      else finish(undefined, reply.result);
    });
  });
}
