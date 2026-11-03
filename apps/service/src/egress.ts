import { isIPv4, Socket } from "node:net";

/** A connection to a host other than loopback while `RECNRUN_FORBID_EGRESS=1`. */
export class EgressForbiddenError extends Error {
  readonly code = "egress-forbidden";
  constructor(host: string) {
    super(`RECNRUN_FORBID_EGRESS=1 forbids connecting to ${host}; only loopback is allowed.`);
    this.name = "EgressForbiddenError";
  }
}

export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return name === "localhost" || name === "::1" || (isIPv4(name) && name.startsWith("127."));
}

function hostOf(options: object): string | undefined {
  // A `path` is a local IPC socket, never the network.
  if ("path" in options && typeof options.path === "string") return undefined;
  return "host" in options && typeof options.host === "string" ? options.host : "localhost";
}

/** The host `Socket#connect` was called with; `net.connect` passes its arguments as one array. */
export function connectHost(args: readonly unknown[]): string | undefined {
  const [first, second] = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  if (typeof first === "object" && first !== null) return hostOf(first);
  if (typeof first === "string" && !/^\d+$/.test(first)) return undefined;
  return typeof second === "string" ? second : "localhost";
}

let forbidden = false;

/** Makes every TCP connection of this process to a non-loopback host throw; it cannot be undone. */
export function forbidEgress(): void {
  if (forbidden) return;
  forbidden = true;
  // The original function value; it is always applied with the socket as `this`.
  const connect: unknown = Object.getOwnPropertyDescriptor(Socket.prototype, "connect")?.value;
  if (typeof connect !== "function") throw new Error("net.Socket has no connect method.");
  // Process-wide on purpose: fetch, WebSocket, http, and tls all connect through net.Socket.
  Socket.prototype.connect = function guardedConnect(this: Socket, ...args: unknown[]) {
    const host = connectHost(args);
    if (host !== undefined && !isLoopbackHost(host)) throw new EgressForbiddenError(host);
    return Reflect.apply(connect, this, args) as Socket;
  } as typeof Socket.prototype.connect;
}
