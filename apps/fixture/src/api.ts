import {
  allowedRedirect,
  endSession,
  SESSION_COOKIES,
  type Call,
  type Handler,
} from "./context.ts";
import { noContent, redirect, sendJson, sessionCookie } from "./http.ts";

const COOKIE = SESSION_COOKIES.api;
const MAX_SLOW_MS = 60_000;
const KEEPALIVE_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function me({ res, user }: Call): void {
  sendJson(res, user === null ? 401 : 200, { user });
}

async function slow(call: Call): Promise<void> {
  const ms = Math.min(Math.max(Number(call.url.searchParams.get("ms")) || 0, 0), MAX_SLOW_MS);
  // Timers may fire a little early against the wall clock; wait until the full delay has passed.
  const end = performance.now() + ms;
  while (performance.now() < end) await sleep(Math.ceil(end - performance.now()));
  sendJson(call.res, 200, { user: call.user, ms });
}

function redirectChain({ res, url }: Call): void {
  const hops = Number(/^\/redirect\/(\d+)$/.exec(url.pathname)?.[1]);
  redirect(res, hops > 1 ? `/redirect/${hops - 1}` : "/me");
}

function privateResponse({ res, user }: Call): void {
  const headers = { "Cache-Control": "private, max-age=60", Vary: "Origin, Cookie" };
  sendJson(res, 200, { user, servedAt: Date.now() }, headers);
}

function events({ req, res, user }: Call): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
  res.write(`retry: 1000\nevent: hello\ndata: ${JSON.stringify({ user })}\n\n`);
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
  req.on("close", () => clearInterval(keepalive));
}

function session({ ctx, res, url }: Call): void {
  const user = ctx.sessions.redeemCode(url.searchParams.get("code"));
  const target = allowedRedirect(ctx, url.searchParams.get("redirect"));
  if (user === null || target === null) {
    sendJson(res, 400, { error: "Unknown or used code, or a redirect outside the fixture" });
    return;
  }
  redirect(res, target, { "Set-Cookie": sessionCookie(COOKIE, ctx.sessions.create(user)) });
}

function logout(call: Call): void {
  redirect(call.res, endSession(call, COOKIE), { "Set-Cookie": sessionCookie(COOKIE, "", 0) });
}

function ledger({ ctx, req, res }: Call): void {
  if (req.method === "POST") {
    ctx.ledger.reset();
    noContent(res);
    return;
  }
  sendJson(res, 200, ctx.ledger.entries());
}

function network({ ctx, req, res, url }: Call): void {
  if (req.method === "POST") {
    const mode = url.searchParams.get("mode");
    if (mode !== "offline" && mode !== "online") {
      sendJson(res, 400, { error: "The mode is offline or online" });
      return;
    }
    ctx.network.offline = mode === "offline";
    // Connections close after this answer is out, or the caller would lose it.
    if (ctx.network.offline) res.once("finish", () => setImmediate(() => ctx.network.closeOpen()));
  }
  sendJson(res, 200, { mode: ctx.network.offline ? "offline" : "online" });
}

function expire({ ctx, res, url }: Call): void {
  const user = url.searchParams.get("user");
  if (!user) {
    sendJson(res, 400, { error: "A user is required" });
    return;
  }
  sendJson(res, 200, { user, expired: ctx.sessions.expire(user) });
}

const ROUTES: Record<string, (call: Call) => void | Promise<void>> = {
  "GET /me": me,
  "GET /slow": slow,
  "GET /private": privateResponse,
  "GET /events": events,
  "GET /session": session,
  "GET /logout": logout,
  "GET /__ledger": ledger,
  "POST /__ledger/reset": ledger,
  "GET /__network": network,
  "POST /__network": network,
  "POST /__expire": expire,
};

/** api.localhost: credentialed JSON endpoints, the session exchange, the shared ledger, and the test controls. */
export function apiHandler(): Handler {
  const actions = new Map<string, number>();
  const act = ({ res, user, url, entry }: Call) => {
    const op = url.searchParams.get("op") ?? "default";
    entry.effect = `act:${op}`;
    const key = `${user}\u0000${op}`;
    const count = (actions.get(key) ?? 0) + 1;
    actions.set(key, count);
    sendJson(res, user === null ? 401 : 200, { user, op, count });
  };
  return (call) => {
    if (call.req.method === "POST" && call.url.pathname === "/act") return act(call);
    if (call.url.pathname.startsWith("/redirect/")) return redirectChain(call);
    const route = ROUTES[`${call.req.method} ${call.url.pathname}`];
    return route ? route(call) : sendJson(call.res, 404, { error: "Not found" });
  };
}
