import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { apiHandler } from "./api.ts";
import {
  isFixtureOrigin,
  SESSION_COOKIES,
  type Call,
  type FixtureContext,
  type Handler,
  type Origins,
  type Role,
} from "./context.ts";
import { noContent, readCookie, sendJson, serveStatic } from "./http.ts";
import { idpHandler } from "./idp.ts";
import { createLedger, type Ledger } from "./ledger.ts";
import { createSessions } from "./sessions.ts";
import { acceptEcho } from "./websocket.ts";

const DEFAULT_PORTS: Record<Role, number> = {
  app: 4600,
  api: 4601,
  idp: 4602,
  staging: 4603,
};
const ROLES = Object.keys(DEFAULT_PORTS) as Role[];
const HOSTNAMES: Record<Role, string> = {
  app: "app.localhost",
  api: "api.localhost",
  idp: "idp.localhost",
  staging: "app.localhost",
};

export interface FixtureOptions {
  /** Port per listener; 0 picks a free port. Defaults to DEFAULT_PORTS. */
  ports?: Partial<Record<Role, number>>;
  /** Address the listeners bind to; Chrome resolves *.localhost to the loopback. */
  host?: string;
}

export interface Fixture {
  origins: Origins;
  ledger: Ledger;
  close(): Promise<void>;
}

function userOf(ctx: FixtureContext, role: Role, req: IncomingMessage): string | null {
  if (role !== "api" && role !== "idp") return null;
  return ctx.sessions.user(readCookie(req, SESSION_COOKIES[role]));
}

function corsHeaders(ctx: FixtureContext, req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!isFixtureOrigin(ctx, origin) || origin === undefined) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST",
    "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] ?? "",
    Vary: "Origin",
  };
}

function appHandler(publicDir: string): Handler {
  const root = join(publicDir, "app");
  return ({ res, url }) => serveStatic(res, root, url.pathname);
}

const HANDLERS: Record<Role, (ctx: FixtureContext) => Handler> = {
  app: (ctx) => appHandler(ctx.publicDir),
  staging: (ctx) => appHandler(ctx.publicDir),
  api: () => apiHandler(),
  idp: (ctx) => idpHandler(ctx.publicDir),
};

function dispatch(handler: Handler, call: Call): void | Promise<void> {
  for (const [name, value] of Object.entries(corsHeaders(call.ctx, call.req))) {
    call.res.setHeader(name, value);
  }
  if (call.req.method === "OPTIONS" || call.url.pathname === "/__marker")
    return noContent(call.res);
  return handler(call);
}

function createListener(ctx: FixtureContext, role: Role, sockets: Set<Duplex>): Server {
  const handler = HANDLERS[role](ctx);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", ctx.origins[role]);
    const user = userOf(ctx, role, req);
    const entry = ctx.ledger.record(req, url, user);
    Promise.resolve(dispatch(handler, { ctx, req, res, url, entry, user })).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "Fixture error" });
      else res.destroy();
    });
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    const url = new URL(req.url ?? "/", ctx.origins[role]);
    ctx.ledger.record(req, url, userOf(ctx, role, req));
    if (role !== "api" || url.pathname !== "/ws") return void socket.destroy();
    sockets.add(socket.on("close", () => sockets.delete(socket)));
    acceptEcho(req, socket);
  });
  return server;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

function closeAll(servers: Server[], sockets: Set<Duplex>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  ).then(() => undefined);
}

/** Starts the app, API, IdP, and staging listeners in one process sharing one ledger. */
export async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const host = options.host ?? "127.0.0.1";
  const ctx: FixtureContext = {
    origins: { app: "", api: "", idp: "", staging: "" },
    ledger: createLedger(),
    sessions: createSessions(),
    publicDir: fileURLToPath(new URL("../public", import.meta.url)),
  };
  const sockets = new Set<Duplex>();
  const servers = ROLES.map((role) => createListener(ctx, role, sockets));
  const ports = await Promise.allSettled(
    ROLES.map((role, index) =>
      listen(servers[index] as Server, options.ports?.[role] ?? DEFAULT_PORTS[role], host),
    ),
  );
  const failure = ports.find((result) => result.status === "rejected");
  if (failure) {
    await closeAll(servers, sockets);
    throw failure.reason;
  }
  ROLES.forEach((role, index) => {
    const port = ports[index];
    if (port?.status === "fulfilled") ctx.origins[role] = `http://${HOSTNAMES[role]}:${port.value}`;
  });
  return { origins: ctx.origins, ledger: ctx.ledger, close: () => closeAll(servers, sockets) };
}
