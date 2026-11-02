type Result = Record<string, unknown>;

interface Reply {
  id?: number;
  result?: Result;
  error?: { message?: string };
}

/** A second CDP client, standing in for a debugger that is not RECnRun. */
export interface CdpClient {
  send(method: string, params?: Result, sessionId?: string): Promise<Result>;
  close(): void;
}

export function openCdpClient(wsEndpoint: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsEndpoint);
    const pending = new Map<number, (reply: Reply) => void>();
    let lastId = 0;
    const send: CdpClient["send"] = (method, params = {}, sessionId) =>
      new Promise((answer, fail) => {
        lastId += 1;
        pending.set(lastId, (reply) => {
          if (reply.error) fail(new Error(`${method} failed: ${reply.error.message ?? "unknown"}`));
          else answer(reply.result ?? {});
        });
        socket.send(JSON.stringify({ id: lastId, method, params, sessionId }));
      });
    socket.addEventListener("error", () => reject(new Error(`No CDP WebSocket at ${wsEndpoint}`)));
    socket.addEventListener("open", () => resolve({ send, close: () => socket.close() }));
    socket.addEventListener("message", (event) => {
      const reply = JSON.parse(String(event.data)) as Reply;
      if (reply.id === undefined) return;
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    });
  });
}
