import { join } from "node:path";
import {
  allowedRedirect,
  endSession,
  SESSION_COOKIES,
  type Call,
  type Handler,
} from "./context.ts";
import { readCookie, readForm, redirect, sendJson, serveStatic, sessionCookie } from "./http.ts";

const COOKIE = SESSION_COOKIES.idp;

async function login({ ctx, req, res }: Call): Promise<void> {
  const form = await readForm(req);
  const user = form.get("username")?.trim();
  const target = allowedRedirect(ctx, form.get("redirect"));
  if (!user || target === null) {
    sendJson(res, 400, { error: "A username and a redirect into the fixture are required" });
    return;
  }
  const exchange = new URL("/session", ctx.origins.api);
  exchange.searchParams.set("code", ctx.sessions.issueCode(user));
  exchange.searchParams.set("redirect", target);
  redirect(res, exchange.href, { "Set-Cookie": sessionCookie(COOKIE, ctx.sessions.create(user)) });
}

function renew({ ctx, req, res, user }: Call): void {
  if (user === null) {
    sendJson(res, 401, { user: null });
    return;
  }
  ctx.sessions.destroy(readCookie(req, COOKIE));
  const cookie = sessionCookie(COOKIE, ctx.sessions.create(user));
  sendJson(res, 200, { user, renewed: true }, { "Set-Cookie": cookie });
}

function logout(call: Call): void {
  const next = new URL("/logout", call.ctx.origins.api);
  next.searchParams.set("redirect", endSession(call, COOKIE));
  redirect(call.res, next.href, { "Set-Cookie": sessionCookie(COOKIE, "", 0) });
}

/** idp.localhost: login form, popup and silent-renew pages, cookie session, logout. */
export function idpHandler(publicDir: string): Handler {
  const root = join(publicDir, "idp");
  return (call) => {
    switch (`${call.req.method} ${call.url.pathname}`) {
      case "POST /login":
        return login(call);
      case "POST /renew":
        return renew(call);
      case "GET /whoami":
        return sendJson(call.res, 200, { user: call.user });
      case "GET /logout":
        return logout(call);
      case "GET /login":
        return serveStatic(call.res, root, "/login.html");
      default:
        return serveStatic(call.res, root, call.url.pathname);
    }
  };
}
