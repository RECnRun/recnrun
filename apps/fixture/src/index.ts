import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { handleApi, type ApiContext } from "./api.ts";
import { serveStatic } from "./static.ts";
import { acceptEcho } from "./websocket.ts";

// Loopback only: the fixture is a test target and must not be reachable from the network.
const HOST = "127.0.0.1";

export interface FixtureOptions {
  /** First origin, `http://127.0.0.1:<port>`; 0 picks a free port. */
  readonly port?: number;
  /** Second origin, `http://localhost:<secondPort>`, for cross-site iframes; 0 picks a free port. */
  readonly secondPort?: number;
}

export interface FixtureUrls {
  readonly first: string;
  readonly second: string;
}

export interface FixtureServer {
  start(): Promise<FixtureUrls>;
  stop(): Promise<void>;
  readonly urls: FixtureUrls;
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  context: ApiContext,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  if (url.pathname.startsWith("/api/")) await handleApi(request, response, url, context);
  else await serveStatic(request, response, url.pathname);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

/** Serves `public/` and the API on two ports; the second is another site for iframes. */
export function createFixtureServer(options: FixtureOptions = {}): FixtureServer {
  const sockets = new Set<Duplex>();
  let urls: FixtureUrls = { first: "", second: "" };
  let serial = 0;
  const context: ApiContext = {
    get urls() {
      return urls;
    },
    nextSerial: () => (serial += 1),
  };
  const servers = [0, 1].map(() => {
    const server = createServer((request, response) => {
      route(request, response, context).catch(() => response.destroy());
    });
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      acceptEcho(request, socket, head);
    });
    return server;
  });
  const [first, second] = servers as [Server, Server];
  return {
    async start() {
      const firstPort = await listen(first, options.port ?? 4600);
      const secondPort = await listen(second, options.secondPort ?? 4601);
      urls = { first: `http://${HOST}:${firstPort}`, second: `http://localhost:${secondPort}` };
      return urls;
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections();
            }),
        ),
      );
    },
    get urls() {
      return urls;
    },
  };
}

/** Reads the two ports from the environment, defaulting to 4600 and 4601. */
export function portsFromEnvironment(env: NodeJS.ProcessEnv): FixtureOptions {
  return {
    port: Number(env.RECNRUN_FIXTURE_PORT ?? 4600),
    secondPort: Number(env.RECNRUN_FIXTURE_SECOND_PORT ?? 4601),
  };
}
